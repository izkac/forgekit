#!/usr/bin/env node
/**
 * `forge guard check --file <path> [--json]` — CLI wrapper over the shared
 * test-tamper classifier (`guard.mjs`). Implements the full decision table;
 * the PreToolUse hook (a later task) only maps this command's exit code to
 * allow/deny.
 *
 * Exit codes: 0 allow, 2 deny, 1 usage error or internal error (git failure,
 * unreadable session, malformed allowance ledger). Callers must never map
 * exit 1 to deny — a broken guard fails open (design D3).
 */

import { REPO_ROOT, loadSession, resolveSessionId, unfinishedSessions } from './lib.mjs';
import { loadProjectConfig } from './config.mjs';
import { classifyGuarded, findAllowance, loadAllowances, makeGitLsTree, resolveFile } from './guard.mjs';

/** D8: fast-allow outside this window. Everything not in this set allows —
 * including an unrecognized/missing phase, which fails open rather than
 * denying on a value the decision table was never given a rule for. */
const DENY_WINDOW_PHASES = new Set(['implement', 'verify', 'review', 'finish']);

/**
 * I4: per-rule refinement of the window above. Every guarded class is frozen
 * for the whole implement→finish span EXCEPT `verify-evidence.md`, which
 * `verify.md` requires the coordinator to *author* during the verify phase
 * itself — freezing it starting at implement (before verify even begins)
 * made every session record a routine allowance for its own required verify
 * evidence (F88), normalizing the escape hatch the guard exists to avoid.
 * It is frozen starting `review` instead, once its content is meant to be
 * settled. `spine.json`/`e2e.json` keep the default (implement onward): per
 * plan-specs.md they are plan deliverables, authored before `forge phase
 * implement` is called, not during it.
 */
const RULE_GUARD_FROM_PHASE = { 'integrity-artifact:verify-evidence.md': 'review' };
const PHASE_ORDER = ['implement', 'verify', 'review', 'finish'];

/**
 * @param {string} rule
 * @param {string} phase already known to be in DENY_WINDOW_PHASES
 * @returns {boolean} whether this rule is frozen (guarded) at this phase
 */
function isRuleFrozenAtPhase(rule, phase) {
  const from = RULE_GUARD_FROM_PHASE[rule];
  if (!from) return true;
  const phaseIdx = PHASE_ORDER.indexOf(phase);
  const fromIdx = PHASE_ORDER.indexOf(from);
  if (phaseIdx === -1 || fromIdx === -1) return true; // defensive: unknown value, keep the safer default
  return phaseIdx >= fromIdx;
}

function usage() {
  process.stderr.write('Usage: forge guard check --file <path> [--json] [--session <id>]\n');
}

/**
 * Human-readable description of what a rule matched, for the deny message.
 * Worded so it reads sensibly for a file that merely shares a protected
 * basename, not as if that specific file *is* the session's evidence.
 * @param {string} rule
 * @returns {string}
 */
function describeRule(rule) {
  if (rule.startsWith('integrity-artifact:')) {
    const basename = rule.slice('integrity-artifact:'.length);
    return (
      `matches the protected filename "${basename}" — files named "${basename}" carry Forge's ` +
      `session/verification evidence in whichever change or session directory they live, and are ` +
      `never edited directly by tool calls, regardless of age`
    );
  }
  if (rule.startsWith('forge-control:')) {
    const basename = rule.slice('forge-control:'.length);
    return (
      `matches Forge's own control-surface filename "${basename}" under .forge/ — project config, the ` +
      `active-session pointer, and session state decide what the guard itself does, so they are never ` +
      `edited directly by tool calls, regardless of session or phase`
    );
  }
  return `matches guarded test glob "${rule}" (tracked at the session's baseCommit)`;
}

/**
 * @param {{ decision: 'allow'|'deny', reason: string, rule: string|null, file: string, sessionId: string|null, extra?: Record<string, unknown>, message?: string }} result
 * @param {boolean} json
 */
function emit({ decision, reason, rule, file, sessionId, extra = {}, message }, json) {
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          decision,
          reason,
          rule: rule ?? null,
          file,
          sessionId: sessionId ?? null,
          ...extra,
          ...(message ? { message } : {}),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (message) {
    process.stdout.write(`${message}\n`);
    return;
  }
  let line = `${decision.toUpperCase()} ${file} (${reason}`;
  if (extra.allowanceReason) line += `: ${extra.allowanceReason}`;
  line += ')';
  process.stdout.write(`${line}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args[0] === '--help' || args[0] === '-h') {
  usage();
  process.exit(0);
}
if (args[0] !== 'check') {
  usage();
  process.exit(1);
}

let rawFile = null;
let json = false;
let sessionIdArg = null;
for (let i = 1; i < args.length; i += 1) {
  if (args[i] === '--file' && args[i + 1] && !args[i + 1].startsWith('-')) {
    rawFile = args[(i += 1)];
  } else if (args[i] === '--json') {
    json = true;
  } else if (args[i] === '--session' && args[i + 1]) {
    sessionIdArg = args[(i += 1)];
  }
}

if (!rawFile) {
  usage();
  process.exit(1);
}

const resolved = resolveFile(rawFile, REPO_ROOT);
if (resolved.outside) {
  emit({ decision: 'allow', reason: 'outside-repo', rule: null, file: resolved.abs, sessionId: null }, json);
  process.exit(0);
}
const rel = resolved.rel;

/**
 * The whole per-session decision table, for one candidate session against
 * `rel` (closed over from the module scope, fixed for this invocation).
 * Never exits — callers decide what an 'error' verdict means (the primary
 * session's error still fails the whole check open via `fail()`; an error
 * from a bystander session in the cross-session sweep below is just skipped,
 * loudly).
 *
 * @param {string} sessionId
 * @returns {
 *   | { verdict: 'error', message: string }
 *   | { verdict: 'allow', reason: string, rule: string | null, extra?: Record<string, unknown> }
 *   | { verdict: 'deny', rule: string }
 * }
 */
function evaluateSession(sessionId) {
  let dir;
  let session;
  try {
    ({ dir, session } = loadSession(sessionId));
  } catch (err) {
    return {
      verdict: 'error',
      message: `forge guard check: could not read session ${sessionId}: ${err instanceof Error ? err.message : err}`,
    };
  }

  if (!DENY_WINDOW_PHASES.has(session.phase)) {
    return { verdict: 'allow', reason: 'phase-out-of-window', rule: null };
  }

  if (!session.baseCommit) {
    process.stderr.write(
      `[forge] Warning: session ${sessionId} has no baseCommit recorded — guard check allowing (no-base-commit).\n`,
    );
    return { verdict: 'allow', reason: 'no-base-commit', rule: null };
  }

  const config = loadProjectConfig(REPO_ROOT);
  const gitLsTree = makeGitLsTree({ cwd: REPO_ROOT, baseCommit: session.baseCommit });

  let classification;
  try {
    classification = classifyGuarded({ relPath: rel, session, config, gitLsTree });
  } catch (err) {
    return { verdict: 'error', message: `forge guard check: ${err instanceof Error ? err.message : err}` };
  }
  if (classification.warning) {
    process.stderr.write(`[forge] Warning: ${classification.warning}\n`);
  }

  if (!classification.guarded) {
    return { verdict: 'allow', reason: 'not-guarded', rule: null };
  }

  // I4: some artifact classes freeze later than the general window (see
  // RULE_GUARD_FROM_PHASE) — a phase inside DENY_WINDOW_PHASES overall can
  // still be out-of-window for this specific rule.
  if (!isRuleFrozenAtPhase(classification.rule, session.phase)) {
    return { verdict: 'allow', reason: 'phase-out-of-window', rule: null };
  }

  let allowances;
  try {
    allowances = loadAllowances(dir);
  } catch (err) {
    return { verdict: 'error', message: `forge guard check: ${err instanceof Error ? err.message : err}` };
  }

  const allowanceEntry = findAllowance(allowances, rel);
  if (allowanceEntry) {
    return {
      verdict: 'allow',
      reason: 'allowance',
      rule: classification.rule,
      extra: { allowanceReason: allowanceEntry?.reason ?? null },
    };
  }

  return { verdict: 'deny', rule: classification.rule };
}

/**
 * C3: a second concurrent session must not turn the guard off globally. A
 * hook invocation carries no `--session` (it cannot know which session an
 * edit belongs to), so it used to resolve through `.forge/active.json` alone
 * — a mutable pointer that a second, out-of-window session (even one created
 * by an unrelated `forge new`) repoints on every creation. Any unfinished
 * session's own baseline can still guard the file regardless of what the
 * pointer currently names, so every one of them gets a say: fail-closed
 * across sessions, not just the one the pointer happens to resolve to.
 *
 * Only used on the no-`--session` path — an explicit `--session <id>` is a
 * deliberate, single-session query and skips this sweep entirely.
 *
 * @param {string | null} excludeId a session already evaluated by the caller
 * @returns {{ id: string, rule: string } | null}
 */
function denyFromAnyOtherSession(excludeId) {
  const candidates = unfinishedSessions();
  if (!Array.isArray(candidates)) return null;
  for (const candidate of candidates) {
    if (candidate.unreadable || candidate.id === excludeId) continue;
    const result = evaluateSession(candidate.id);
    if (result.verdict === 'error') {
      process.stderr.write(
        `[forge] Warning: could not evaluate session ${candidate.id} for the cross-session guard check — ${result.message}\n`,
      );
      continue;
    }
    if (result.verdict === 'deny') {
      return { id: candidate.id, rule: result.rule };
    }
  }
  return null;
}

/**
 * @param {{ id: string, rule: string }} denial
 */
function emitDeny(denial, json) {
  // F92: the escape must name the governing session. With two concurrent
  // in-window sessions, `forge test-allow` without --session hits the
  // gate-class ambiguity refusal — the printed escape would fail verbatim.
  const message =
    `Guarded: ${rel} ${describeRule(denial.rule)}. ` +
    `Escape: forge test-allow ${rel} --reason "<why>" --session ${denial.id}`;
  emit(
    { decision: 'deny', reason: 'guarded', rule: denial.rule, file: rel, sessionId: denial.id, message },
    json,
  );
  process.exit(2);
}

const sessionResolution = resolveSessionId(sessionIdArg);
if (sessionResolution.id === null) {
  // `problem`/`ambiguous` mean resolution did not simply find "no sessions" —
  // it could not tell (unreadable sessions dir) or could not choose (several
  // open, the active.json pointer naming none of them). Design D3 fails open
  // either way, but silently is a laundered decision the operator never sees.
  // One line, not `sessionAmbiguityMessage` (that is for gate-class commands
  // that refuse; this command never refuses).
  if (sessionResolution.problem || sessionResolution.ambiguous) {
    process.stderr.write(
      `[forge] Warning: ${
        sessionResolution.problem ||
        `${sessionResolution.candidates?.length ?? 0} sessions are unfinished and could not be resolved`
      } — guard check allowing (no-session).\n`,
    );
  }
  // C3: even when no single session can be resolved, another unfinished
  // session may still individually guard this file — "could not decide
  // which session" must not become a silent allow when a real one exists.
  const otherDenial = !sessionIdArg ? denyFromAnyOtherSession(null) : null;
  if (otherDenial) emitDeny(otherDenial, json);
  emit({ decision: 'allow', reason: 'no-session', rule: null, file: rel, sessionId: null }, json);
  process.exit(0);
}
const sessionId = sessionResolution.id;

const primary = evaluateSession(sessionId);
if (primary.verdict === 'error') {
  // F91: an unreadable primary session.json must not fail open for EVERY
  // file — another unfinished session may still guard this one. Sweep first,
  // exactly like the id===null path above, and only then report the error.
  const sweepDenial = !sessionIdArg ? denyFromAnyOtherSession(sessionId) : null;
  if (sweepDenial) emitDeny(sweepDenial, json);
  fail(primary.message);
}
if (primary.verdict === 'deny') emitDeny({ id: sessionId, rule: primary.rule }, json);

// primary.verdict === 'allow' here. C3: sweep every other unfinished session
// (skipped entirely for an explicit --session — see denyFromAnyOtherSession's
// docstring) before trusting that allow.
const otherDenial = !sessionIdArg ? denyFromAnyOtherSession(sessionId) : null;
if (otherDenial) {
  process.stderr.write(
    `[forge] Warning: session ${sessionId} allows ${rel}, but unfinished session ${otherDenial.id} guards it — ` +
      'denying (a second open session must not turn the guard off).\n',
  );
  emitDeny(otherDenial, json);
}

emit(
  { decision: 'allow', reason: primary.reason, rule: primary.rule, file: rel, sessionId, extra: primary.extra ?? {} },
  json,
);
process.exit(0);
