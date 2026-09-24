#!/usr/bin/env node
/**
 * Record tier-2 test evidence for a Forge implement task.
 *
 * Writes `.forge/sessions/<session-id>/tasks/<task>/test-evidence.md` using
 * the canonical template from the forge skill
 * (`references/test-evidence.md`). An existing file is overwritten — the
 * latest run wins. A non-zero `--exit` is refused unless `--allow-fail`
 * is passed.
 *
 * Usage:
 *   forge evidence --task <nn-slug> [options] -- <cmd> [args…]        # executed (preferred)
 *   forge evidence --tier3 [options] -- <cmd> [args…]                 # tier-3 stamp → verify-runs.jsonl
 *   forge evidence --task <nn-slug> --command <cmd> --exit <code> --summary <text> [options]
 *                                                                     # transcribed (legacy; warns)
 *
 * Executed mode: everything after `--` is spawned (argv array, no shell) and
 * the exit code + output tail are captured from the process — the model
 * proposes the command, the tool decides the verdict. Transcribed mode takes
 * the exit code on the caller's word and says so in the file.
 *
 * Options:
 *   --task <nn-slug>    Task directory name, e.g. 03-record-evidence (required)
 *   --command <cmd>     Test command that was run (required unless --no-tdd is
 *                        given with no command details at all)
 *   --exit <code>       Exit code of the test command (required alongside --command)
 *   --summary <text>    Pass/fail summary, e.g. "3/3 pass" (required alongside --command)
 *   --no-tdd            Declare the task has no applicable red→green test cycle
 *                        (docs/config-only work) — exempts it from the
 *                        red→green pairing gate in `forge integrity-check`.
 *                        Requires --reason. May be combined with
 *                        --command/--exit/--summary (e.g. a docs task that
 *                        still ran a lint command) — the declaration marker
 *                        stays unambiguous either way.
 *   --reason <text>     Why no test cycle applies (required with --no-tdd)
 *   --tier <label>      Tier label (default: "2 (task-scoped — not full workspace unless noted)")
 *   --session <id>      Session id (default: sessionId from .forge/active.json)
 *   --allow-fail        Write evidence even when the exit code is non-zero
 *   --tier3             Executed mode only: stamp a tier-3 run into
 *                        <session>/verify-runs.jsonl instead of a task file
 *   --forge-dir <path>  Forge root directory (default: .forge under cwd)
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CALLER_EXEC_SPAWN, resolveCallerExecGate } from './exec-gate.mjs';
import { refreshIntegritySeal } from './integrity-seal.mjs';
import { unfinishedSessions } from './lib.mjs';

export const DEFAULT_TIER = '2 (task-scoped — not full workspace unless noted)';
export const TIER3_LABEL = '3 (full workspace)';

/** `Recorded by:` values — readers key on the executed one to tell a captured exit code from a claimed one. */
export const RECORDED_BY_EXECUTED = 'forge evidence (executed — exit code and output captured from the process)';
export const RECORDED_BY_TRANSCRIBED = 'implementer subagent (coordinator transcript — exit code supplied by caller, UNVERIFIED)';
const TAIL_LINES = 20;

// `checkTddEvidence` (integrity.mjs) reads a task's test-evidence.md for
// this literal token to decide whether the task is exempt from the
// red→green pairing gate. `hasNoTddDeclaration` there requires it to appear
// as a WHOLE LINE (never a substring inside another line) alongside a
// non-empty reason line — never a bare substring match — so:
//   - free text that merely *quotes* the token (a --summary describing this
//     very feature) can never satisfy it, since it always shares its line
//     with a `- **Summary:** …` prefix;
//   - `runRecordEvidence` additionally refuses to let --task/--command/
//     --summary/--tier contain this token at all, so the CLI is the token's
//     only author and it can only ever land on its own line;
//   - a bare marker appended by anything other than the CLI (e.g. a hand or
//     Bash edit with no --reason) still reads as "not declared".
export const NO_TDD_MARKER = '<!-- forge:no-tdd-declared -->';

// The exact prefix `buildEvidence` writes before the reason text. Read back
// by `hasNoTddDeclaration` (integrity.mjs) to require a genuine, non-empty
// reason alongside the marker — one parser of the shape, shared by writer
// and reader, so they cannot silently drift apart on what "a reason" means.
export const NO_TDD_REASON_LABEL = '- **No-TDD reason:**';

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const opts = {
    task: null,
    command: null,
    exit: null,
    summary: null,
    tier: null,
    session: null,
    allowFail: false,
    forgeDir: null,
    noTdd: false,
    reason: null,
    tier3: false,
    /** @type {string[]} everything after `--`: the command to execute */
    cmdArgv: [],
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      opts.cmdArgv = argv.slice(i + 1);
      break;
    }
    if (arg === '--tier3') opts.tier3 = true;
    else if (arg === '--task') opts.task = argv[++i];
    else if (arg === '--command') opts.command = argv[++i];
    else if (arg === '--exit') opts.exit = argv[++i];
    else if (arg === '--summary') opts.summary = argv[++i];
    else if (arg === '--tier') opts.tier = argv[++i];
    else if (arg === '--session') opts.session = argv[++i];
    else if (arg === '--allow-fail') opts.allowFail = true;
    else if (arg === '--forge-dir') opts.forgeDir = argv[++i];
    else if (arg === '--no-tdd') opts.noTdd = true;
    else if (arg === '--reason') opts.reason = argv[++i];
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }

  return opts;
}

/**
 * Render the canonical test-evidence template.
 *
 * `command`/`exit`/`summary` are omitted (not printed as empty/blank fields)
 * when null — the shape a `--no-tdd` declaration with no accompanying command
 * takes. `noTddReason`, when non-null, prepends the durable `NO_TDD_MARKER`
 * line `checkTddEvidence` reads back, plus the reviewer-visible reason text.
 *
 * @param {{ task: string, tier: string, command?: string | null, exit?: number | null, summary?: string | null, runAt: string, noTddReason?: string | null, recordedBy?: string, outputTail?: string | null }} fields
 * @returns {string}
 */
export function buildEvidence({
  task,
  tier,
  command,
  exit,
  summary,
  runAt,
  session,
  sessionFrom,
  noTddReason,
  recordedBy = RECORDED_BY_TRANSCRIBED,
  outputTail = null,
}) {
  return [
    `# Test evidence — Task ${task}`,
    '',
    // Which session this was recorded against, and **how that was decided** —
    // the second half is the honest part. The id alone is written from the same
    // variable as the path, so it can only ever agree with itself; what a reader
    // needs to know is whether it was named or guessed from the pointer.
    ...(session ? [`- **Session:** ${session}${sessionFrom ? ` (${sessionFrom})` : ''}`] : []),
    `- **Tier:** ${tier}`,
    ...(noTddReason != null ? [NO_TDD_MARKER, `${NO_TDD_REASON_LABEL} ${noTddReason}`] : []),
    ...(command != null ? [`- **Command:** \`${command}\``] : []),
    ...(exit != null ? [`- **Exit code:** ${exit}`] : []),
    ...(summary != null ? [`- **Summary:** ${summary}`] : []),
    `- **Run at:** ${runAt}`,
    `- **Recorded by:** ${recordedBy}`,
    ...(outputTail ? ['', '```text', outputTail, '```'] : []),
    '',
  ].join('\n');
}

/**
 * Run the command the caller named and report what actually happened. argv
 * array, no shell — same reasoning as `tdd-run.mjs`. Output is streamed back
 * to the terminal after the run and its last lines kept for the evidence file.
 *
 * @param {string[]} cmdArgv
 * @param {string} cwd
 * @returns {{ command: string, exit: number | null, tail: string, error: string | null }}
 */
export function executeCommand(cmdArgv, cwd) {
  const [cmd, ...args] = cmdArgv;
  const command = cmdArgv.join(' ');
  const res = spawnSync(cmd, args, {
    cwd,
    ...CALLER_EXEC_SPAWN,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) return { command, exit: null, tail: '', error: res.error.message };
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  process.stdout.write(out);
  const lines = out.split(/\r?\n/).filter((l) => l.trim() !== '');
  const tail = lines.slice(-TAIL_LINES).join('\n').slice(-4000);
  return { command, exit: res.status, tail, error: null };
}

/**
 * Resolve the session id: explicit `--session` wins, otherwise the sessionId
 * from `<forgeDir>/active.json`.
 *
 * @param {string | null} session
 * @param {string} forgeDir
 * @returns {string | null}
 */
function resolveSessionId(session, forgeDir) {
  if (session) return { id: session, warning: null, ambiguous: false };

  // THIS FILE WAS THE THIRTEENTH CALL SITE AND APPEARED IN NO AUDIT. It carried
  // its own copy of "read active.json", so a sweep looking for `readActive`
  // importers could not see it. The lesson is the audit's: the criterion has to
  // be "decides which session to act on", never "imports the helper the last
  // bug used".
  //
  // The first fix borrowed the *enumerator* and kept its own decision, which is
  // the same mistake one layer down — it wrote even where the shared resolver
  // would have answered "no defensible session", including into a finished one.
  // This routes the decision and keeps only the severity, which is this
  // command's to choose.
  const candidates = unfinishedSessions(path.join(forgeDir, 'sessions'));
  if (candidates === null) {
    return { id: null, warning: `could not read ${path.join(forgeDir, 'sessions')}`, ambiguous: true };
  }
  /** @type {string | null} */
  let active = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(forgeDir, 'active.json'), 'utf8'));
    if (typeof parsed?.sessionId === 'string') active = parsed.sessionId;
  } catch {
    active = null;
  }
  const activeIsOpen = active !== null && candidates.some((c) => c.id === active);
  if (candidates.length > 1) {
    return activeIsOpen
      ? {
          id: active,
          ambiguous: true,
          warning:
            `${candidates.length} sessions are unfinished; recording against ${active} ` +
            '(from .forge/active.json). Pass --session <id> to record against another.',
        }
      : { id: null, ambiguous: true, warning: `${candidates.length} sessions are unfinished and .forge/active.json names none of them` };
  }
  if (activeIsOpen) return { id: active, warning: null, ambiguous: false };
  // A pointer naming finished work must not win over the one session still
  // open — evidence recorded against a closed session is evidence nobody reads.
  if (candidates.length === 1) return { id: candidates[0].id, warning: null, ambiguous: false };
  // Nothing open to be ambiguous *between* — a project whose sessions predate
  // `session.json`, or one whose only session is finished. The pointer is the
  // only answer there is, and there is no rival for it to be wrong about.
  // Matches `lib.mjs`'s `resolveSessionId`, deliberately: two resolvers that
  // disagree about the same edge is how this class of bug starts.
  return { id: active, ambiguous: false, warning: null };
}

/**
 * @param {ReturnType<typeof parseArgs>} opts
 * @param {string} [cwd]
 * @param {() => Date} [now]
 * @returns {{ exitCode: number; message: string }}
 */
export function runRecordEvidence(opts, cwd = process.cwd(), now = () => new Date()) {
  const executed = Array.isArray(opts.cmdArgv) && opts.cmdArgv.length > 0;
  if (executed && (opts.command != null || opts.exit != null || opts.summary != null)) {
    return {
      exitCode: 1,
      message: '`-- <cmd>` executes the command itself — do not also pass --command/--exit/--summary (those are the transcribed path).',
    };
  }
  if (opts.tier3 && !executed) {
    return { exitCode: 1, message: '--tier3 stamps an executed run: pass the command after `--`.' };
  }
  if (!opts.task && !opts.tier3) {
    return { exitCode: 1, message: '--task is required' };
  }

  // THE CLI MUST BE THE MARKER'S ONLY AUTHOR. `command`/`summary`/`tier`/
  // `task` are interpolated into the same evidence file the marker itself
  // lives in, and none of them go through `--no-tdd`. Without this check, an
  // implementer's own summary of this feature — "green, see notes on
  // <!-- forge:no-tdd-declared -->" — quoted the exact token and exempted its
  // own task from the pairing gate with no --no-tdd, no --reason, and no
  // stamps: `hasNoTddDeclaration`'s whole-line match (see integrity.mjs)
  // closes the same hole for text embedded inside a labelled line like
  // `- **Summary:** …`, but this refusal is the layer that stops the token
  // from ever reaching the file at all, regardless of what future evidence
  // readers do with it.
  for (const [field, value] of [
    ['task', opts.task],
    ['command', opts.command],
    ['summary', opts.summary],
    ['tier', opts.tier],
  ]) {
    if (typeof value === 'string' && value.includes(NO_TDD_MARKER)) {
      return {
        exitCode: 1,
        message:
          `--${field} must not contain the no-tdd declaration marker (${NO_TDD_MARKER}) — ` +
          'that token may only be written by forge evidence --no-tdd --reason "<text>".',
      };
    }
  }

  if (opts.noTdd && !(typeof opts.reason === 'string' && opts.reason.trim().length > 0)) {
    return {
      exitCode: 1,
      message: '--reason is required with --no-tdd — declaring a task exempt without saying why is not a declaration',
    };
  }

  // A docs-only task declared via --no-tdd may have no command to report at
  // all. But once any one of --command/--exit/--summary is given, all three
  // are required, same as the non-declaring path — a partial trio is not
  // useful evidence either way.
  const anyCommandFieldGiven = opts.command != null || opts.exit != null || opts.summary != null;
  if (!executed && (!opts.noTdd || anyCommandFieldGiven)) {
    for (const field of ['command', 'exit', 'summary']) {
      if (!opts[field]) {
        return { exitCode: 1, message: `--${field} is required (or execute the command: forge evidence --task <nn-slug> -- <cmd>)` };
      }
    }
  }

  let testExit = null;
  if (opts.exit != null) {
    testExit = Number(opts.exit);
    if (!Number.isInteger(testExit)) {
      return { exitCode: 1, message: `--exit must be an integer, got: ${opts.exit}` };
    }
  }

  const forgeDir = path.resolve(cwd, opts.forgeDir ?? '.forge');
  const {
    id: sessionId,
    warning: sessionWarning,
    ambiguous: sessionAmbiguous,
  } = resolveSessionId(opts.session, forgeDir);
  if (!sessionId) {
    return {
      exitCode: 1,
      message: sessionWarning
        ? `Cannot tell which session to record against — ${sessionWarning}. Pass --session <id>.`
        : 'No active session. Run forge:new first or pass --session.',
    };
  }
  if (sessionWarning) process.stderr.write(`[forge] Warning: ${sessionWarning}\n`);

  const sessionDir = path.join(forgeDir, 'sessions', sessionId);
  if (!fs.existsSync(sessionDir)) {
    return { exitCode: 1, message: `Session dir not found: ${sessionDir} (session ${sessionId})` };
  }

  if (executed) {
    const gate = resolveCallerExecGate({
      command: 'forge evidence',
      cmdArgv: opts.cmdArgv,
      cwd,
      forgeDir,
      env: opts.env,
      confirm: opts.confirm,
    });
    if (!gate.allowed) {
      return { exitCode: 1, message: (gate.message ?? 'forge evidence: execution refused').trimEnd() };
    }
  }

  if (opts.tier3) {
    // Tier 3 is one fresh full-workspace run at verify. Its stamp is a ledger
    // line, not a task file: verify-evidence.md stays the coordinator's prose
    // and this is the executed fact it must cite.
    const startedAt = now().toISOString();
    const t0 = Date.now();
    const run = executeCommand(opts.cmdArgv, cwd);
    const stamp = {
      command: run.command,
      exit: run.exit,
      ok: run.exit === 0,
      startedAt,
      durationMs: Date.now() - t0,
      tail: run.tail,
      ...(run.error ? { error: run.error } : {}),
    };
    const ledger = path.join(sessionDir, 'verify-runs.jsonl');
    fs.appendFileSync(ledger, `${JSON.stringify(stamp)}\n`, 'utf8');
    refreshIntegritySeal({ sessionDir, repoRoot: cwd });
    const receipt = [
      `- **Command:** \`${run.command}\``,
      `- **Exit code:** ${run.exit ?? `spawn failed: ${run.error}`}`,
      `- **Run at:** ${startedAt}`,
      `- **Recorded by:** ${RECORDED_BY_EXECUTED} → \`verify-runs.jsonl\``,
    ].join('\n');
    return {
      exitCode: stamp.ok ? 0 : 1,
      message: `stamped: ${ledger} (exit ${run.exit ?? 'null'})\n\nPaste into verify-evidence.md:\n${receipt}`,
    };
  }

  let session = {};
  try {
    session = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'));
  } catch {
    // Legacy fixtures and sessions without readable metadata retain the old path.
  }
  const tddLedger = path.join(sessionDir, 'tasks', opts.task, 'tdd-runs.jsonl');
  if (session?.features?.tddEvidence === true && !opts.noTdd && !fs.existsSync(tddLedger)) {
    return {
      exitCode: 1,
      message:
        `Plain evidence cannot start task ${opts.task} in a session with executed TDD evidence enabled. ` +
        `Have the implementer run forge tdd run --session ${sessionId} --task ${opts.task} during the real RED→GREEN cycle; ` +
        'do not reconstruct stamps retroactively. Use --no-tdd --reason only when no behavior changed.',
    };
  }

  let command = opts.command;
  let summary = opts.summary;
  let outputTail = null;
  if (executed) {
    const run = executeCommand(opts.cmdArgv, cwd);
    if (run.error) {
      return { exitCode: 1, message: `failed to execute ${opts.cmdArgv[0]}: ${run.error} (nothing recorded)` };
    }
    command = run.command;
    testExit = run.exit;
    outputTail = run.tail;
    summary = `exit ${run.exit} — captured by forge evidence; output tail below`;
  } else if (!opts.noTdd || anyCommandFieldGiven) {
    process.stderr.write(
      '[forge] Warning: transcribed evidence — the exit code was supplied by the caller, not observed. ' +
        `Prefer: forge evidence --task ${opts.task} -- <cmd>\n`,
    );
  }

  if (testExit !== null && testExit !== 0 && !opts.allowFail) {
    return {
      exitCode: 1,
      message: `Refusing to record failing evidence (exit code ${testExit}). Fix the tests and re-run, or pass --allow-fail to record anyway.`,
    };
  }

  const taskDir = path.join(sessionDir, 'tasks', opts.task);
  const filePath = path.join(taskDir, 'test-evidence.md');

  // OVERWRITING SOMEBODY ELSE'S RUN IS NOT RECOVERABLE. The file is gitignored,
  // `score.mjs` reads its exit code into the evidence ratio, and that lands in
  // the durable ledger — so a guessed session that clobbers an existing
  // `test-evidence.md` destroys a record and moves another change's score.
  //
  // THE GUARD CANNOT ASK THE FILE WHOSE IT IS. A previous version wrote a
  // `- **Session:** <id>` header and compared it against the session it had
  // resolved to. Both come from the same variable — the header is written from
  // `sessionId`, and the path is `sessions/<sessionId>/tasks/…` — so the
  // comparison was a tautology that could only fire on files the product cannot
  // produce. It read as a guard and was a no-op: an agent working on A ran the
  // bare command, the pointer said B, and B's evidence was replaced by A's
  // failing run at exit 0, with the file still claiming it was B's.
  //
  // When the session was a guess, there is nothing on disk that knows better.
  // So: creating a new file on a guess is a stray file and only warns;
  // *replacing* one refuses, and `--session` is the way through — naming the
  // session makes the resolution certain, after which re-runs overwrite freely.
  if (sessionAmbiguous && fs.existsSync(filePath)) {
    return {
      exitCode: 1,
      message:
        `Refusing to overwrite existing evidence for task ${opts.task} in session ${sessionId} ` +
        'while more than one session is unfinished — this session was resolved from ' +
        '.forge/active.json, not named, so it may not be the one this run belongs to.\n' +
        'Re-run with --session <id>. Naming it also lets later runs of the same task overwrite freely.',
    };
  }
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    filePath,
    buildEvidence({
      task: opts.task,
      session: sessionId,
      sessionFrom: opts.session
        ? 'named with --session'
        : sessionAmbiguous
          ? 'resolved from .forge/active.json while several sessions were open'
          : null,
      tier: opts.tier ?? DEFAULT_TIER,
      command,
      exit: testExit,
      summary,
      runAt: now().toISOString(),
      noTddReason: opts.noTdd ? opts.reason : null,
      recordedBy: executed ? RECORDED_BY_EXECUTED : RECORDED_BY_TRANSCRIBED,
      outputTail,
    }),
    'utf8',
  );
  refreshIntegritySeal({ sessionDir, repoRoot: cwd });

  return { exitCode: 0, message: `wrote: ${filePath}${executed ? ` (executed, exit ${testExit})` : ''}` };
}

function printHelp() {
  console.log(`Usage:
  forge evidence --task <nn-slug> [options] -- <cmd> [args…]     executed: runs the command, captures exit + output
  forge evidence --tier3 [options] -- <cmd> [args…]              executed tier-3 stamp → <session>/verify-runs.jsonl
  forge evidence --task <nn-slug> --command <cmd> --exit <code> --summary <text> [options]
                                                                 transcribed (legacy): exit code on the caller's word; warns

Record tier-2 test evidence for a Forge implement task at
.forge/sessions/<session-id>/tasks/<task>/test-evidence.md (latest run wins).

Options:
  --tier3             With \`-- <cmd>\`: stamp a tier-3 run instead of a task file
  --task <nn-slug>    Task directory name, e.g. 03-record-evidence (required)
  --command <cmd>     Test command that was run (required unless --no-tdd is
                       given with no command details at all)
  --exit <code>       Exit code of the test command (required alongside --command)
  --summary <text>    Pass/fail summary, e.g. "3/3 pass" (required alongside --command)
  --no-tdd            Declare the task has no applicable red→green test cycle
                       (docs/config-only work); exempts it from the pairing
                       gate. Requires --reason. May combine with --command/
                       --exit/--summary.
  --reason <text>     Why no test cycle applies (required with --no-tdd)
  --tier <label>      Tier label (default: "${DEFAULT_TIER}")
  --session <id>      Session id (default: sessionId from .forge/active.json)
  --allow-fail        Write evidence even when --exit is non-zero
  --forge-dir <path>  Forge root directory (default: .forge under cwd)
  Executed mode (\`-- <cmd>\`) is refused unless FORGEKIT_ALLOW_EXEC=1,
  exec.allowCallerCommands=true, or a TTY confirm. Transcribed mode does not spawn.
  -h, --help          Show this help
`);
}

function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      printHelp();
      process.exit(0);
    }
    const result = runRecordEvidence(opts);
    if (result.exitCode === 0) {
      console.log(result.message);
    } else {
      console.error(result.message);
    }
    process.exit(result.exitCode);
  } catch (err) {
    console.error(/** @type {Error} */ (err).message);
    process.exit(1);
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main();
}
