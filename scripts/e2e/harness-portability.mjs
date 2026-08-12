#!/usr/bin/env node
/**
 * Product loop for the recorded-harness contract — the executable steps behind
 * specs/changes/harness-setup-probe/e2e.json.
 *
 * Drives the SHIPPED binary (packages/cli/bin/forge.mjs) against a scratch
 * project in a temp dir, because the thing under test is what an operator's
 * `forge` does on their checkout, not what a module exports. Unit tests in
 * packages/cli/src/e2e-cli.test.mjs cover the same behaviour one layer down.
 *
 * Phases (each is one e2e.json step; state persists in a fixed temp dir):
 *   all          run every phase in order — this rig's own recorded `probe`
 *   boot         scratch project + session fixture
 *   record       forge e2e harness --set … --setup … --probe …  → read config back
 *   show         forge e2e harness / forge e2e init surface both fields
 *   red-run      a failing loop names the recorded setup
 *   quiet-cases  green-with-setup and red-without-setup print no hint
 *
 * Session-telemetry loop (specs/changes/session-telemetry/e2e.json), sharing
 * `boot` and layering its own fixture on top:
 *   telemetry-collect  synthetic host transcript + sidecar + dispatch ledger →
 *                      forge metrics collect
 *   telemetry-analyze  forge phase done → digest → forge analyze --json
 *
 * Review-authorship-evidence loop (specs/changes/review-authorship-evidence/
 * e2e.json), also layering on `boot`:
 *   review-evidence-decides   a review file that says "self-check" beside a host
 *                             record of a real reviewer → independent, on host
 *                             evidence, past the money/auth done gate
 *   review-evidence-substance the same file beside a host record of a reviewer
 *                             that made one request → the host cannot certify
 *                             it, the prose decides, and the gate refuses
 *   review-evidence-survives  delete the transcript; the recorded verdict does
 *                             not move
 *
 * Review-freeze-qualifier loop (specs/changes/review-freeze-qualifier/e2e.json),
 * also layering on `boot`, and on the same review fixture as the loop above:
 *   review-evidence-pruned-record  a below-floor unstopped `final` dispatch
 *                             (prose reading independent, so `finish` freezes
 *                             independent/inferred with the unit on record),
 *                             then the `subagents/` directory is emptied —
 *                             files deleted, directory kept — which is the one
 *                             shape `hostFinalReview` cannot tell apart from
 *                             "nothing was ever dispatched": the host stays
 *                             readable and answers self/host, the one genuine
 *                             negative that function produces. `done` must
 *                             keep the frozen verdict rather than let that
 *                             negative overwrite it and refuse permanently
 *                             (F49/F52) — the shape `review-evidence-survives`
 *                             does not cover, because deleting the whole host
 *                             config makes the host unavailable instead.
 *
 * Partial-binding-unreadable loop (specs/changes/partial-binding-unreadable/
 * e2e.json), also layering on `boot`, and on the same review fixture:
 *   review-evidence-partial-binding  a session bound to TWO host sessions, the
 *                             first fully readable and carrying a prescribed
 *                             non-`final` dispatch, the second carrying the
 *                             prescribed `final` dispatch with its host
 *                             session directory `chmod 000`. Before the fix,
 *                             `reviewEvidence` answered confidently from the
 *                             readable half — `final` absent from `units` —
 *                             and the census read that as self/host, refusing
 *                             a change whose review genuinely happened. After
 *                             the fix the unreadable half makes the whole
 *                             answer unavailable, prose decides, and the gate
 *                             *accepts* on independent/inferred — the inverse
 *                             of every sibling step above, and deliberately
 *                             so: a refusal-shaped assertion would pass both
 *                             before and after the fix.
 *
 * Review-stamp-at-dispatch loop (specs/changes/review-stamp-at-dispatch/
 * e2e.json), also layering on `boot`, and on the same review fixture:
 *   review-stamp-decides      ONE session, driven three times, with exactly one
 *                             thing changed between each pair of runs. First
 *                             the control: a high-risk change whose review file
 *                             says self-check, whose host record has been
 *                             pruned off disk, and which has never been
 *                             stamped — `self`/`inferred`, and the money/auth
 *                             gate refuses. Then `forge review-label final`
 *                             writes the stamp and NOTHING ELSE moves: same
 *                             file bytes, same pruned host — and the same gate
 *                             passes on `independent`/`recorded`. Then the
 *                             D3 guard: the same stamped session with a
 *                             below-floor `final` dispatch planted back on the
 *                             host record refuses again, because a stamp must
 *                             not resurrect the token-dispatch forgery
 *                             `review-evidence-substance` closed.
 *
 * Doctor-hook-wiring loop (specs/changes/doctor-unwired-hooks/e2e.json), its own
 * scratch project rather than layered on `boot` — `boot`'s fixture has no
 * `specs/specs/` dir, which would fail the *project* check for a reason this
 * loop is not about, and the point here is that only hook wiring should vary
 * between the red and green runs:
 *   doctor-wiring  a project with `.claude/hooks/` holding two `forge-*.mjs`
 *                  files and one non-forge file, wired for the non-forge file
 *                  only → the shipped `forge doctor --json` reports exit 1,
 *                  `checks.hooks.ok: false`, exactly those two basenames
 *                  unwired, and a message naming `forge-hooks.snippet.json`;
 *                  the human surface prints a matching `[FAIL]` line; wiring
 *                  the two basenames flips both to exit 0
 *
 * Test-guard loop (specs/changes/tdd-evidence-guard/e2e.json), its own
 * scratch project (a real git repo — the classifier's whole job is "tracked
 * at baseCommit", which only a git worktree can answer) rather than layered
 * on `boot`:
 *   test-guard  `forge init --claude` on a fresh project merges the hooks
 *               snippet into `.claude/settings.json` and `forge doctor` then
 *               exits 0 (F74); against a git-backed session in `implement`,
 *               `forge guard check` denies a baseline test tracked at
 *               `baseCommit` (naming the matched rule and the `forge
 *               test-allow` escape) and allows a test file created during
 *               the session; `forge test-allow` flips the same baseline
 *               check to allow with its reason; final-review C1/C2/C3 against
 *               the shipped binary — `guard.testGlobs: []` does not disable
 *               the guard and `.forge/config.json` is itself denied (C1),
 *               `session.json`/`active.json` are themselves denied (C2), and
 *               a decoy out-of-window session named by `active.json` does not
 *               shadow the in-window session that actually guards the file
 *               (C3, naming the real session in the deny); and the backstop —
 *               `forge integrity-check`, not the hook — refuses a modified
 *               and a deleted baseline test with no allowance, naming both,
 *               then clears once both are allowanced, with a clean
 *               before/after run proving the guard finding is what moved it.
 *               Two more, product-loop acceptance for F79/F90 (both fixed on
 *               this branch): the installed `.claude/hooks/forge-prompt-hook.mjs`
 *               (the exact file `forge init` wrote above) is fed a
 *               `/forge …; touch <marker> #` prompt over stdin with a real
 *               `forge` relay first on PATH — not a stub — so the assertion
 *               is that the marker is never created AND that the relay
 *               logged the real spawn carrying the prompt unchanged (F79);
 *               and, because the classifier only folds case on darwin/win32
 *               and this runner is Linux, a small spawned driver imports the
 *               shipped `classifyGuarded`/`makeGitLsTree` directly and calls
 *               them once with `caseInsensitive: true` and once with
 *               `false` against a case-variant of a tracked baseline test —
 *               guarded under folding, not guarded under exact match (F90)
 *
 * TDD-evidence loop (specs/changes/tdd-evidence-guard/e2e.json), its own
 * scratch project (no git needed — this loop never reads the worktree),
 * carrying `features.tddEvidence: true`:
 *   tdd-evidence  `forge tdd run` re-runs ONE command (a flag-file check)
 *                 that genuinely fails then genuinely passes and stamps
 *                 both, sharing cmd+args across the pair; a contradicted
 *                 `--expect fail` against a passing command exits non-zero
 *                 and is still stamped; a sibling task holding only a
 *                 pass-stamp makes `forge integrity-check` refuse naming it
 *                 while the red→green task stays clear; a fourth task
 *                 carrying an ok fail-stamp for one command and an ok
 *                 pass-stamp for a different, unrelated command is refused
 *                 the same way (final-review I2: pairing correlates by
 *                 command, `false` then `true` does not clear the gate); a
 *                 third task's evidence written without `--no-tdd` keeps it
 *                 gated, and re-recording it with `forge evidence --no-tdd
 *                 --reason "…"` clears it — the exemption marker read
 *                 straight from `record-evidence.mjs`, never retyped; and
 *                 `forge score` counts the tdd-run-only task's evidence
 *                 toward tier-2 coverage
 *
 * `all` is this rig's own recorded probe (`.forge/config.json`'s
 * `e2e.harness.probe`) — every phase above that is layered onto a shared
 * fixture or built once and forgotten stays out of it, because re-running it
 * here would mean re-running the fixture it depends on out of order. Only
 * self-contained phases join the roster: the original five, and now
 * `doctor-wiring`, `test-guard`, and `tdd-evidence`, each of which builds and
 * tears down its own project and touches nothing `boot` or its siblings
 * leave behind.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Imported, never retyped: these fixtures describe dispatches on either side of
// the shipped floor, so if the floor moves they must move with it. A literal
// would rot — under a raised floor the control's reviewer becomes a token one,
// `forge phase done` refuses, and the step fails. Loudly, not silently: that
// failure is the correct outcome for a stale fixture, but it is a maintenance
// cost, and the import removes it.
//
// What the import does NOT buy — an earlier version of this comment claimed it
// did, and it was measured false: it does not make the step notice a floor set
// above what real reviewers do. Raise the floor past the corpus maximum and
// these fixtures rise with it, so both steps stay green while the product would
// be refusing every genuine review. Nothing in this harness canaries that. The
// guard against it is the corpus recorded beside the constant in
// `review-census.mjs` and the rule that it is re-measured before it moves.
import { FINAL_REVIEW_REQUEST_FLOOR } from '../../packages/cli/src/review-census.mjs';

// Same discipline as the import above, for the same reason: the exemption
// marker `checkTddEvidence` reads back is this module's to define, and a
// retyped literal here would silently drift from it if it ever changed.
import { NO_TDD_MARKER } from '../../packages/cli/src/record-evidence.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FORGE_BIN = path.join(REPO, 'packages', 'cli', 'bin', 'forge.mjs');
// Fixed path (phases are separate processes and must share state), but keyed to
// this checkout so two clones can run the loop at the same time.
const SCRATCH = path.join(
  os.tmpdir(),
  `forgekit-e2e-harness-${createHash('sha256').update(REPO).digest('hex').slice(0, 10)}`,
);

const SETUP_CMD = 'npx playwright install chromium';
const PROBE_CMD = 'npm run test:e2e';
const START_CMD = 'npm run build && npm run preview';
const HINT = 'Harness setup recorded';

/**
 * Run the real forge binary in `cwd`; never throws on a non-zero exit.
 *
 * The operator's own host session id is dropped: this rig drives a throwaway
 * project, and a session bound to the id of the Claude Code session that
 * happens to be running the suite would be measuring the wrong thing.
 *
 * `stdout` is returned separately from the combined `out` because `--json`
 * output has to be parsed, and forge writes advisory notes to stderr.
 */
function forge(cwd, args, extraEnv = {}) {
  const env = { ...process.env, FORGEKIT_FLEET_DIR: path.join(SCRATCH, '.fleet'), ...extraEnv };
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync(process.execPath, [FORGE_BIN, ...args], { cwd, encoding: 'utf8', env });
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '', code: r.status };
}

/**
 * A throwaway project with an active session tracking a specs change — the
 * minimum shape `forge e2e` needs to resolve a change dir.
 */
function makeProject(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  const sessionDir = path.join(dir, '.forge', 'sessions', 's1');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify({ id: 's1', slug: 'scratch', planType: 'specs', openspecChange: 'my-change' })}\n`,
  );
  fs.writeFileSync(path.join(dir, '.forge', 'active.json'), `${JSON.stringify({ sessionId: 's1' })}\n`);
  fs.writeFileSync(
    path.join(dir, '.forge', 'config.json'),
    `${JSON.stringify({ plan: { engine: 'specs', dir: 'specs' } }, null, 2)}\n`,
  );
  fs.mkdirSync(path.join(dir, 'specs', 'changes', 'my-change'), { recursive: true });
  return dir;
}

/**
 * A one-step loop for the fixture change. `ok: false` fails the way a missing
 * probe runtime does — the tool's own diagnostic on stderr and a non-zero exit,
 * which is exactly what forge cannot distinguish from a code regression.
 */
function writeLoop(dir, ok) {
  const probe = path.join(dir, 'probe.mjs');
  fs.writeFileSync(
    probe,
    ok
      ? 'process.exit(0);\n'
      : "console.error(\"Error: browser executable doesn't exist at /root/.cache/ms-playwright/chromium-1234/chrome\");\nprocess.exit(1);\n",
  );
  fs.writeFileSync(
    path.join(dir, 'specs', 'changes', 'my-change', 'e2e.json'),
    `${JSON.stringify({
      steps: [{ name: 'smoke', cmd: `node ${JSON.stringify(probe.replace(/\\/g, '/'))}` }],
    })}\n`,
  );
}

/* ---------- doctor-hook-wiring fixture ---------- */

/** Kept apart from SCRATCH: this loop needs its own `specs/specs/` layout, and
 *  `boot`'s rmSync must not reach it or a run interleaved with other phases
 *  could delete it out from under a later step. */
const DOCTOR_WIRING_PROJECT = `${SCRATCH}-doctor-wiring`;
/** Two forge hook files; a fixture must derive its expectations from these,
 *  never from prose describing them. */
const DOCTOR_FORGE_HOOKS = ['forge-alpha.mjs', 'forge-beta.mjs'];
/** One non-forge hook — realistic clutter `checkHookWiring` must ignore. */
const DOCTOR_NON_FORGE_HOOK = 'eslint-changed.mjs';

/**
 * A project doctor can grade on its own: the minimal specs-engine layout
 * (`checkSpecsProject` needs only `specs/changes/` and `specs/specs/` to
 * exist) plus `.claude/hooks/` holding `DOCTOR_FORGE_HOOKS` and
 * `DOCTOR_NON_FORGE_HOOK`. No `.claude/settings.json` is written here —
 * that is the one thing `writeDoctorWiring` varies between the red and
 * green runs, so nothing else about the project changes between them.
 */
function makeDoctorWiringProject(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'specs', 'changes'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'specs', 'specs'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.forge', 'config.json'),
    `${JSON.stringify({ plan: { engine: 'specs', dir: 'specs' } }, null, 2)}\n`,
  );
  const hooksDir = path.join(dir, '.claude', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  // Empty files: checkHookWiring reads basenames off disk, never contents.
  for (const name of [...DOCTOR_FORGE_HOOKS, DOCTOR_NON_FORGE_HOOK]) {
    fs.writeFileSync(path.join(hooksDir, name), '');
  }
  return dir;
}

/**
 * Rewrite `.claude/settings.json` so exactly `wiredBasenames` are referenced
 * by a hook command — the realistic shape a Claude Code settings file wires
 * hooks in, one `PostToolUse` entry per basename, not a shortcut the real
 * surface would never produce.
 */
function writeDoctorWiring(dir, wiredBasenames) {
  const settings = {
    hooks: {
      PostToolUse: wiredBasenames.map((name) => ({
        matcher: 'Edit',
        hooks: [{ type: 'command', command: `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${name}"` }],
      })),
    },
  };
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
}

/** Last `n` lines — the runner reports only a 30-line tail, and a long context
 *  silently pushes the assertion message out of it. */
function tail(text, n) {
  return String(text ?? '').split('\n').slice(-n).join('\n');
}

function fail(message, context) {
  process.stderr.write(`ASSERTION FAILED: ${message}\n${context ?? ''}\n`);
  process.exit(1);
}

/* ---------- test-guard fixture ---------- */

/** Kept apart from SCRATCH and DOCTOR_WIRING_PROJECT: this is the first loop
 *  that needs a REAL git repo (the classifier's whole job is "tracked at
 *  baseCommit", which only a git worktree can answer), so it must not share
 *  a directory any sibling phase might `rmSync` out from under it. */
const TEST_GUARD_PROJECT = `${SCRATCH}-test-guard`;

/**
 * Mirrors `guard-cli.test.mjs`'s own `git()` — this harness had no git
 * wrapper before test-guard because no prior phase needed to commit real
 * content; the classifier under test is defined entirely in terms of what
 * git considers tracked at a commit, so a fixture without a real repo would
 * not be exercising it at all.
 */
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (in ${cwd}): ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A `forge` executable placed first on PATH for the F79 hook-injection check
 * below. Unlike a stub, it relays every call straight through to the
 * SHIPPED `FORGE_BIN` (after logging the argv it received) — the injection
 * assertion only means something if the real CLI runs at the far end of the
 * hook's spawn; a double that merely proves the hook didn't crash would
 * prove nothing about the fix.
 * @param {string} shimDir
 * @param {string} logFile
 */
function makeForgeRelay(shimDir, logFile) {
  fs.mkdirSync(shimDir, { recursive: true });
  const shimPath = path.join(shimDir, 'forge');
  fs.writeFileSync(
    shimPath,
    [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const { spawnSync } = require("node:child_process");',
      `fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");`,
      `const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(FORGE_BIN)}, ...process.argv.slice(2)], { stdio: "inherit" });`,
      'process.exit(typeof r.status === "number" ? r.status : 1);',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.chmodSync(shimPath, 0o755);
}

/**
 * Writes a tiny ESM driver that imports the SHIPPED `classifyGuarded` /
 * `makeGitLsTree` from `guard.mjs` and prints one classification's result —
 * spawned as its own process so the platform decision under test
 * (`caseInsensitive`) is exactly the argument given, never this harness
 * process's own `process.platform` (Linux on CI, which would answer `false`
 * no matter what). This drives the shipped module's exported functions
 * directly, not a reimplementation of the fold logic.
 * @param {string} scriptPath
 */
function writeCaseFoldDriver(scriptPath) {
  fs.writeFileSync(
    scriptPath,
    [
      "import { pathToFileURL } from 'node:url';",
      '',
      'const [, , guardModulePath, cwd, baseCommit, relPath, caseInsensitiveFlag] = process.argv;',
      "const { classifyGuarded, makeGitLsTree } = await import(pathToFileURL(guardModulePath).href);",
      "const caseInsensitive = caseInsensitiveFlag === 'true';",
      'const gitLsTree = makeGitLsTree({ cwd, baseCommit, caseInsensitive });',
      'const result = classifyGuarded({ relPath, config: {}, gitLsTree, caseInsensitive });',
      'process.stdout.write(`${JSON.stringify({ guarded: result.guarded, rule: result.rule })}\\n`);',
      '',
    ].join('\n'),
    'utf8',
  );
}

/* ---------- tdd-evidence fixture ---------- */

/** Kept apart from every git-backed fixture above: this loop never reads the
 *  worktree (`checkTddEvidence` only ever reads `tasks/*\/tdd-runs.jsonl` and
 *  `test-evidence.md`), so it is plain files under `.forge/`, no git init. */
const TDD_EVIDENCE_PROJECT = `${SCRATCH}-tdd-evidence`;

/**
 * A project carrying one session flagged `features.tddEvidence: true` — the
 * per-session opt-in `checkTddEvidence` requires — with a `notApplicable`
 * spine so the pairing gate is the only thing `forge integrity-check` can
 * still refuse on (no e2e.json, no deferrals, no BLOCKED marker to trip).
 */
function makeTddEvidenceProject(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  const sessionDir = path.join(dir, '.forge', 'sessions', 's1');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify({
      id: 's1',
      slug: 'tdd-fixture',
      phase: 'implement',
      features: { tddEvidence: true },
    })}\n`,
  );
  fs.writeFileSync(path.join(dir, '.forge', 'active.json'), `${JSON.stringify({ sessionId: 's1' })}\n`);
  fs.writeFileSync(
    path.join(sessionDir, 'spine.json'),
    `${JSON.stringify({ notApplicable: 'tdd-evidence e2e fixture — no runtime spine' }, null, 2)}\n`,
  );
  return { dir, sessionDir };
}

/* ---------- session telemetry fixture ---------- */

const HOST_ID = 'e2e0host-0000-1111-2222-333344445555';
const HOST_CFG = path.join(SCRATCH, '.claude-host');
/** 10 coordinator requests + 2 subagent requests. The step's expected total. */
const PARENT_REQUESTS = 10;
const SIDECAR_REQUESTS = 2;

/**
 * One assistant transcript line.
 *
 * The host writes one line per content block and repeats the whole `usage`
 * object on each, so the fixture below spreads 12 requests over 24 lines: a
 * reader that counted lines, or summed usage across them, gets a plausible and
 * completely wrong answer. That is the regression this loop exists to catch.
 */
function assistantLine(requestId, block, at, sidechain) {
  return JSON.stringify({
    type: 'assistant',
    requestId,
    timestamp: at,
    version: '2.1.220',
    isSidechain: sidechain,
    ...(sidechain ? { agentId: 'a1' } : {}),
    message: {
      id: `msg_${requestId}`,
      model: 'claude-opus-5',
      content: [{ type: 'tool_use', id: `toolu_${requestId}_${block}`, name: 'Bash' }],
      usage: {
        input_tokens: 3,
        output_tokens: 40,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 7,
      },
    },
  });
}

/** A synthetic host transcript plus one subagent sidecar, under HOST_CFG. */
function plantTranscripts(at) {
  const projectDir = path.join(HOST_CFG, 'projects', '-scratch-project');
  const sidecarDir = path.join(projectDir, HOST_ID, 'subagents');
  fs.rmSync(HOST_CFG, { recursive: true, force: true });
  fs.mkdirSync(sidecarDir, { recursive: true });

  const parent = [];
  for (let i = 0; i < PARENT_REQUESTS; i += 1) {
    for (let block = 0; block <= i % 3; block += 1) {
      parent.push(assistantLine(`req_p${i}`, block, at, false));
    }
  }
  parent.push(
    JSON.stringify({
      type: 'user',
      timestamp: at,
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_req_p0_0', is_error: true }] },
    }),
  );
  fs.writeFileSync(path.join(projectDir, `${HOST_ID}.jsonl`), `${parent.join('\n')}\n`, 'utf8');

  const sidecar = [];
  for (let i = 0; i < SIDECAR_REQUESTS; i += 1) {
    for (let block = 0; block < 2; block += 1) {
      sidecar.push(assistantLine(`req_s${i}`, block, at, true));
    }
  }
  fs.writeFileSync(path.join(sidecarDir, 'agent-a1.jsonl'), `${sidecar.join('\n')}\n`, 'utf8');
  fs.writeFileSync(
    path.join(sidecarDir, 'agent-a1.meta.json'),
    `${JSON.stringify({
      agentType: 'general-purpose',
      description: 'PRIVATE-E2E-DESCRIPTION',
      toolUseId: 'toolu_dispatch_1',
      spawnDepth: 1,
      model: 'opus',
    })}\n`,
    'utf8',
  );
}

/* ---------- review-authorship-evidence fixture ---------- */

const REVIEW_HOST_ID = 'e2e0revw-0000-1111-2222-666677778888';
/** Kept apart from HOST_CFG so the two loops cannot borrow each other's record. */
const REVIEW_HOST_CFG = path.join(SCRATCH, '.claude-review-host');
const REVIEW_PROJECT_DIR = '-scratch-review-project';
/** A host config dir with no transcripts at all, for the prose-only control. */
const EMPTY_HOST_CFG = path.join(SCRATCH, '.claude-empty-host');
/** The project the control runs in: same review file, no host record. */
const PROSE_PROJECT = `${SCRATCH}-prose`;
/**
 * Exactly what a final-review dispatch is prescribed to be described as.
 *
 * The trailing session id is what makes the record attributable: without it the
 * join is "a review dispatch somewhere in this host conversation", and one
 * Claude Code conversation routinely hosts several Forge sessions. `s1` is the
 * session `makeProject` creates.
 */
const FINAL_REVIEW_DISPATCH = 'forge-review final s1';

/**
 * A genuine reviewer dispatch that is not the *final* one — any unit other
 * than `final` would do. Used by `review-evidence-partial-binding` to give
 * the readable half of its split binding something real on record, so that
 * half alone can supply `prescribed > 0` while still lacking the unit that
 * actually decides the gate. Mirrors the `forge-review group-01 …` fixture
 * `review-evidence.test.mjs` uses for the same reason one layer down.
 */
const IMPLEMENT_REVIEW_DISPATCH = 'forge-review implement s1';

/**
 * The second host session id in `review-evidence-partial-binding`'s split
 * binding. Kept apart from `REVIEW_HOST_ID` so the two halves are two
 * distinct, independently-permissioned directories on disk — the ordinary
 * shape of a session resumed under a new host id, which `bindHost` appends
 * rather than replaces.
 */
const REVIEW_HOST_ID_2 = 'e2e0revw-0000-1111-2222-aaaabbbbcccc';

/**
 * The whole point of this loop, in one string.
 *
 * It must read as a SELF-CHECK to the prose rule — that is what makes the host
 * record outranking it mean anything. `review-evidence-decides` proves that by
 * running the identical bytes through a project with no host record and
 * requiring `self`; if this text ever drifts to something the prose rule would
 * also call `independent`, the control goes red and says so, rather than the
 * loop passing for the wrong reason.
 *
 * The heading is the phrasing Forge's own skill prescribes for a self-written
 * review, and the body says in plain English that no reviewer was dispatched.
 */
const SELF_CHECK_REVIEW = `# Final review

**Reviewer:** coordinator — self-check

No reviewer subagent was dispatched for this change; I read back my own diff
and convinced myself it was fine. Everything below is my own assessment of my
own work.

## Verdict

APPROVED.
`;

/**
 * The opposite fixture: prose that reads INDEPENDENT to the census's own prose
 * rule, for `review-evidence-pruned-record` — every other review-evidence phase
 * needs `SELF_CHECK_REVIEW` because they measure the host record outranking a
 * self-check; this one needs the frozen verdict to already be `independent`
 * before the prune, or a re-graded `self`/`host` reading would refuse for the
 * ordinary reason (an unreviewed high-risk change) and prove nothing about the
 * keep rule. Byte-for-byte the fixture `set-phase.test.mjs` calls
 * `INDEPENDENT_PROSE`: a `**Verdict:**` line and a named outside reviewer, no
 * `Reviewer:`-prefixed attribution line and no self-review/self-check/self-audit
 * phrase, so `review-census.mjs`'s `SELF_REVIEW_RE` does not match it.
 */
const INDEPENDENT_REVIEW = '# Final review\n\n**Verdict: APPROVED** — opus reviewer 4d2 read the whole diff.\n';

/** A change the money/auth floor applies to, so the done gate actually runs. */
const HIGH_RISK_PROPOSAL = `# Proposal — scratch fixture

Adds a payment authorization step to the checkout flow. This change therefore
touches money and auth, which is what puts it behind the hard floor in
\`forge phase done\`.
`;

/**
 * Layer the review fixture onto an existing scratch project — a high-risk
 * change, a finishable session and a self-check final review.
 *
 * Layered rather than built, so `boot` stays the loop's first step and means
 * something, exactly as `telemetry-collect` layers on it.
 *
 * `hostId` is the only difference between the two projects this phase builds:
 * with it, the host has a dispatch record to answer from; without it, nothing
 * but the prose can decide. Everything else — the review file above all — is
 * written from the same constants in both.
 *
 * @param {string} dir
 * @param {{ createdAt: string, hostId?: string }} options
 */
function layerReviewFixture(dir, options) {
  const changeDir = path.join(dir, 'specs', 'changes', 'my-change');
  fs.mkdirSync(changeDir, { recursive: true });
  fs.writeFileSync(path.join(changeDir, 'proposal.md'), HIGH_RISK_PROPOSAL, 'utf8');
  fs.writeFileSync(path.join(changeDir, 'tasks.md'), '## Group 1\n\n- [x] 1.1 wire it\n', 'utf8');
  // notApplicable, so the integrity gate does not also demand an executed e2e
  // loop *inside* the fixture project — this loop is the one being executed.
  fs.writeFileSync(
    path.join(changeDir, 'spine.json'),
    `${JSON.stringify(
      { change: 'my-change', notApplicable: 'scratch fixture — nothing is wired', rows: [] },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const sessionDir = path.join(dir, '.forge', 'sessions', 's1');
  fs.mkdirSync(path.join(sessionDir, 'reviews'), { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'reviews', 'final-review.md'), SELF_CHECK_REVIEW, 'utf8');
  fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# Verify\n\nAll checks green.\n', 'utf8');

  const sessionFile = path.join(sessionDir, 'session.json');
  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  session.createdAt = options.createdAt;
  session.updatedAt = options.createdAt;
  session.phase = 'implement';
  session.tasksTotal = 1;
  session.tasksComplete = 1;
  session.phaseHistory = [{ phase: 'implement', at: options.createdAt }];
  if (options.hostId) {
    session.host = { agent: 'claude-code', sessionIds: [options.hostId], boundAt: options.createdAt };
  } else {
    delete session.host;
  }
  fs.writeFileSync(sessionFile, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
  return { dir, sessionDir, changeDir };
}

/**
 * The requests a forged dispatch makes: one. Measured, not chosen — the record
 * that prompted the floor made exactly one request, and `review-census.mjs`
 * documents it. Kept as a constant so the guard in `review-evidence-substance`
 * can compare it to the shipped floor rather than assert a relationship between
 * two literals.
 */
const TOKEN_DISPATCH_REQUESTS = 1;

/**
 * Best-effort recursive `chmod 0o755`, so a directory a previous run left at
 * `000` cannot wedge a later one. Chmods each directory it visits BEFORE
 * reading it — a directory has to be unlocked to be walked into at all — so a
 * poisoned node anywhere in the tree is healed the moment the walk reaches
 * it, not only when it is already readable enough to be found. Never throws:
 * a missing path, a file passed by mistake, or a permission this process
 * does not own are all left alone rather than raising out of a fixture setup
 * step, and the `rmSync` right after this call in `plantReviewerDispatch`
 * will complain clearly enough if something remains genuinely stuck.
 *
 * @param {string} dir
 */
function unlockTree(dir) {
  let entries;
  try {
    fs.chmodSync(dir, 0o755);
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) unlockTree(path.join(dir, entry.name));
  }
}

/**
 * A host record of one final-review subagent: the sidecar meta describing it as
 * `forge-review final <session-id>` — the session id is what attributes the
 * record, so no transcript timestamp has to place it.
 *
 * The main transcript beside it is not decoration — `findTranscripts` locates a
 * sidecar directory by finding `<hostId>.jsonl` first, so without it there is
 * no dispatch record to read at all.
 *
 * `requests` is what the two review steps disagree about, and it is the only
 * thing they disagree about: a reviewer that did work versus one that did not.
 * The lines carry distinct request ids because a request is what is counted —
 * one id restated across content blocks is still one request.
 *
 * `options` is additive and every existing caller omits it, so the defaults
 * below reproduce this function's original behaviour byte for byte: plant
 * `FINAL_REVIEW_DISPATCH` under `REVIEW_HOST_ID`, after wiping the whole
 * `REVIEW_HOST_CFG` first. `review-evidence-partial-binding` is the one
 * caller that overrides them, to plant a *second*, differently-labelled host
 * session beside the first rather than in place of it — `reset: false` skips
 * the wipe, or the second call would erase the first half of its own fixture.
 *
 * @param {string} at ISO timestamp inside `[session.createdAt, now]`
 * @param {number} requests distinct requests the dispatch made
 * @param {{ hostId?: string, description?: string, reset?: boolean }} [options]
 */
function plantReviewerDispatch(at, requests, options = {}) {
  const hostId = options.hostId ?? REVIEW_HOST_ID;
  const description = options.description ?? FINAL_REVIEW_DISPATCH;
  const reset = options.reset ?? true;
  const projectDir = path.join(REVIEW_HOST_CFG, 'projects', REVIEW_PROJECT_DIR);
  const sidecarDir = path.join(projectDir, hostId, 'subagents');
  // Self-healing, not merely defensive: `review-evidence-partial-binding`
  // chmods a directory under here to `000`, and every restore it has is
  // best-effort — an operator's Ctrl-C during that step's `forge phase done`
  // is a real way for a `000` directory to survive into the next run. Without
  // this, `rmSync` below hits it mid-walk with `EACCES: scandir` and every
  // review-evidence step after it, not only this one's, is wedged until a
  // human runs `chmod` by hand. `unlockTree` chmods every directory node
  // before reading it, so a poisoned entry is unlocked the moment the walk
  // reaches it rather than needing to already be readable to be found.
  if (reset) {
    unlockTree(REVIEW_HOST_CFG);
    fs.rmSync(REVIEW_HOST_CFG, { recursive: true, force: true });
  }
  fs.mkdirSync(sidecarDir, { recursive: true });

  fs.writeFileSync(
    path.join(projectDir, `${hostId}.jsonl`),
    `${assistantLine('req_coord0', 0, at, false)}\n`,
    'utf8',
  );
  const lines = [];
  for (let i = 0; i < requests; i += 1) lines.push(assistantLine(`req_rv${i}`, 0, at, true));
  fs.writeFileSync(path.join(sidecarDir, 'agent-rv1.jsonl'), `${lines.join('\n')}\n`, 'utf8');
  fs.writeFileSync(
    path.join(sidecarDir, 'agent-rv1.meta.json'),
    `${JSON.stringify({
      agentType: 'general-purpose',
      description,
      toolUseId: 'toolu_dispatch_review',
      spawnDepth: 1,
      model: 'opus',
    })}\n`,
    'utf8',
  );
  return { projectDir, sidecarDir, hostDir: path.join(projectDir, hostId) };
}

/** An empty host config dir — "no record", as distinct from "a record of none". */
function plantNoHostRecord() {
  fs.rmSync(EMPTY_HOST_CFG, { recursive: true, force: true });
  fs.mkdirSync(path.join(EMPTY_HOST_CFG, 'projects'), { recursive: true });
}

/**
 * The last `.forge/sessions.jsonl` line, parsed — the durable record that
 * outlives both the session directory and the host transcript.
 *
 * @param {string} file
 * @returns {Record<string, any> | null}
 */
function lastDigest(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    return lines.length ? JSON.parse(lines.at(-1)) : null;
  } catch {
    return null;
  }
}

/**
 * The dispatch stamps `forge review-label` wrote for a scratch session.
 *
 * Deliberately NOT `readStamps` from `review-stamp.mjs`. That module is half of
 * the mechanism under test, and importing it here would let a reader that
 * agrees with a broken writer pass this loop — the same reason every other
 * phase reads the CLI's own artefacts off disk with `JSON.parse` rather than
 * through the code that produced them. Returns `null` for "no file", which is
 * a state `review-stamp-decides`' control asserts, distinct from `[]`.
 *
 * @param {string} sessionDir
 * @returns {{ file: string, doc: Record<string, any> | null }}
 */
function stampsOf(sessionDir) {
  const file = path.join(sessionDir, 'reviews', 'dispatches.json');
  if (!fs.existsSync(file)) return { file, doc: null };
  return { file, doc: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

/** The frozen verdict on a scratch session, or null. */
function frozenVerdictOf(sessionDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8')).reviewVerdict ?? null;
  } catch {
    return null;
  }
}

const phase = process.argv[2];

// `all` is the harness's own probe: it must prove THIS rig, self-contained, with
// no active forge session and no e2e.json in play. It checks only child exit
// codes, so every phase carries its own fail() assertions rather than leaning on
// the `expect` regexes in e2e.json — the gate has those, the probe does not, and
// a probe that only watches exit codes reports GREEN against a stubbed change.
const ALL_ROSTER = [
  'boot',
  'record',
  'show',
  'red-run',
  'quiet-cases',
  'doctor-wiring',
  'test-guard',
  'tdd-evidence',
];

if (phase === 'all') {
  for (const name of ALL_ROSTER) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), name], {
      encoding: 'utf8',
      cwd: REPO,
    });
    process.stdout.write(`--- ${name} ---\n${r.stdout ?? ''}${r.stderr ?? ''}`);
    if (r.status !== 0) {
      process.stderr.write(`\nHARNESS PROBE FAILED at phase "${name}" (exit ${r.status})\n`);
      process.exit(1);
    }
  }
  process.stdout.write(`\nHARNESS PROBE GREEN — ${ALL_ROSTER.length}/${ALL_ROSTER.length} phases\n`);
  process.exit(0);
}

if (phase === 'boot') {
  // The review loop's control project is a *sibling* of SCRATCH, so the rmSync
  // inside makeProject does not reach it. Clear it here or it outlives every
  // documented `rm -rf $SCRATCH`.
  fs.rmSync(PROSE_PROJECT, { recursive: true, force: true });
  makeProject(SCRATCH);
  process.stdout.write(`SCRATCH PROJECT READY ${SCRATCH}\n`);
} else if (phase === 'record') {
  const { out, code } = forge(SCRATCH, [
    'e2e',
    'harness',
    '--set',
    'vite preview + playwright smoke',
    '--start',
    START_CMD,
    '--setup',
    SETUP_CMD,
    '--probe',
    PROBE_CMD,
    '--dir',
    'e2e',
  ]);
  if (code !== 0) fail(`recording exited ${code}`, out);
  // Read the committed artifact, not the CLI's own echo — the next session
  // reads this file, so this is the assertion that matters.
  const cfg = JSON.parse(fs.readFileSync(path.join(SCRATCH, '.forge', 'config.json'), 'utf8'));
  const h = cfg?.e2e?.harness ?? {};
  if (cfg?.plan?.engine !== 'specs') fail('harness write clobbered the plan config', JSON.stringify(cfg));
  if (h.setup !== SETUP_CMD) fail(`setup not recorded: ${h.setup}`, JSON.stringify(h, null, 2));
  if (h.probe !== PROBE_CMD) fail(`probe not recorded: ${h.probe}`, JSON.stringify(h, null, 2));
  if (h.start !== START_CMD) fail(`start not recorded: ${h.start}`, JSON.stringify(h, null, 2));
  process.stdout.write(`CONFIG e2e.harness.start=${h.start}\n`);
  process.stdout.write(`CONFIG e2e.harness.setup=${h.setup}\n`);
  process.stdout.write(`CONFIG e2e.harness.probe=${h.probe}\n`);
} else if (phase === 'show') {
  const shown = forge(SCRATCH, ['e2e', 'harness']);
  process.stdout.write(`${shown.out}\n`);
  // `forge e2e init` is where a later session meets the harness without going
  // looking for it — the prerequisite has to reach that surface too.
  const init = forge(SCRATCH, ['e2e', 'init', '--force']);
  process.stdout.write(`INIT\n${init.out}\n`);
  for (const [surface, text] of [
    ['forge e2e harness', shown.out],
    ['forge e2e init', init.out],
  ]) {
    for (const [label, value] of [
      ['Setup:', SETUP_CMD],
      ['Probe:', PROBE_CMD],
    ]) {
      if (!text.includes(label)) fail(`${surface} omitted the ${label} row`, text);
      if (!text.includes(value)) fail(`${surface} omitted the ${label} value`, text);
    }
  }
} else if (phase === 'red-run') {
  writeLoop(SCRATCH, false);
  const { out, code } = forge(SCRATCH, ['e2e', 'run']);
  process.stdout.write(`${out}\nEXIT ${code}\n`);
  if (code === 0) fail('a failing loop must exit non-zero', out);
  if (!out.includes(HINT)) fail('red loop did not name the recorded setup', out);
  if (!out.includes(SETUP_CMD)) fail('hint omitted the setup command itself', out);
  // Advisory before verdict: a hint printed after FAILED is a hint nobody reads.
  if (out.indexOf(SETUP_CMD) > out.indexOf('FAILED')) fail('hint printed after the verdict', out);
} else if (phase === 'quiet-cases') {
  // Green with a setup on file: the hint is for red runs only.
  writeLoop(SCRATCH, true);
  const green = forge(SCRATCH, ['e2e', 'run']);
  if (green.out.includes(HINT)) fail('green run printed the prerequisite hint', green.out);
  if (green.code !== 0) fail(`green loop exited ${green.code}`, green.out);
  process.stdout.write('NO HINT green-with-setup\n');

  // Red with no setup recorded: nothing to attribute, so say nothing.
  const bare = makeProject(`${SCRATCH}-bare`);
  forge(bare, ['e2e', 'harness', '--set', 'preview only', '--start', START_CMD]);
  writeLoop(bare, false);
  const red = forge(bare, ['e2e', 'run']);
  if (red.out.includes(HINT)) fail('hint printed with no recorded setup', red.out);
  if (red.code === 0) fail('a failing loop must exit non-zero', red.out);
  process.stdout.write('NO HINT red-without-setup\n');
} else if (phase === 'telemetry-collect') {
  // Layer a bound session and a synthetic host transcript onto `boot`'s
  // project, then run the shipped `forge metrics collect` over it.
  const sessionDir = path.join(SCRATCH, '.forge', 'sessions', 's1');
  const sessionFile = path.join(sessionDir, 'session.json');
  const createdAt = new Date(Date.now() - 3600_000).toISOString();
  const at = new Date(Date.now() - 60_000).toISOString();

  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  session.createdAt = createdAt;
  session.updatedAt = at;
  session.phase = 'implement';
  session.tasksTotal = 1;
  session.tasksComplete = 1;
  session.host = { agent: 'claude-code', sessionIds: [HOST_ID], boundAt: createdAt };
  session.phaseHistory = [{ phase: 'implement', at: createdAt }];
  fs.writeFileSync(sessionFile, `${JSON.stringify(session, null, 2)}\n`, 'utf8');

  plantTranscripts(at);

  // Three dispatches, one of which the policy had to rewrite → skipped = 1.
  fs.writeFileSync(
    path.join(sessionDir, 'dispatches.jsonl'),
    `${[
      { ts: at, tool: 'Agent', decision: 'allow', modelRequested: 'opus', modelResolved: 'opus' },
      { ts: at, tool: 'Agent', decision: 'rewrite', modelRequested: 'sonnet', modelResolved: 'opus' },
      { ts: at, tool: 'Agent', decision: 'allow', modelRequested: 'opus', modelResolved: 'opus' },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n')}\n`,
    'utf8',
  );

  const { out, code } = forge(SCRATCH, ['metrics', 'collect'], { CLAUDE_CONFIG_DIR: HOST_CFG });
  if (code !== 0) fail(`forge metrics collect exited ${code}`, out);

  const doc = JSON.parse(fs.readFileSync(path.join(sessionDir, 'metrics.json'), 'utf8'));
  if (doc.available !== true) fail('collector degraded on a planted transcript', doc.reason);
  const expected = PARENT_REQUESTS + SIDECAR_REQUESTS;
  if (doc.requests !== expected) {
    fail(`requests ${doc.requests}, expected ${expected} — per-content-block lines counted twice?`, out);
  }
  if (doc.subagents.length !== 1) fail(`subagents ${doc.subagents.length}, expected 1`, out);
  if (doc.dispatches.skipped !== 1) fail(`dispatchesSkipped ${doc.dispatches.skipped}, expected 1`, out);
  if (JSON.stringify(doc).includes('PRIVATE-E2E-DESCRIPTION')) {
    fail('a subagent description reached the persisted document', out);
  }

  process.stdout.write(
    `METRICS requests=${doc.requests} subagents=${doc.subagents.length} dispatchesSkipped=${doc.dispatches.skipped}\n`,
  );
} else if (phase === 'telemetry-analyze') {
  // The other half of the loop: finishing the session must collect, digest and
  // then be readable back as numbers by a separate command.
  const done = forge(
    SCRATCH,
    ['phase', 'done', '--allow-incomplete', 'e2e telemetry fixture'],
    { CLAUDE_CONFIG_DIR: HOST_CFG },
  );
  if (done.code !== 0) fail(`forge phase done exited ${done.code}`, done.out);

  const digest = JSON.parse(
    fs
      .readFileSync(path.join(SCRATCH, '.forge', 'sessions.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .at(-1),
  );
  const expected = PARENT_REQUESTS + SIDECAR_REQUESTS;
  if (digest.metrics?.requests !== expected) {
    fail(`digest requests ${digest.metrics?.requests}, expected ${expected}`, JSON.stringify(digest));
  }
  if (digest.dispatchesSkipped !== 1) {
    fail(`digest dispatchesSkipped ${digest.dispatchesSkipped}, expected 1`, JSON.stringify(digest));
  }
  if (digest.subagentsDispatched !== 1) {
    fail(`digest subagentsDispatched ${digest.subagentsDispatched}, expected 1`, JSON.stringify(digest));
  }

  const analysis = forge(SCRATCH, ['analyze', '--json']);
  if (analysis.code !== 0) fail(`forge analyze exited ${analysis.code}`, analysis.out);
  const a = JSON.parse(analysis.stdout);
  const { sessionsWithMetrics, sessionsTotal } = a.coverage;
  if (sessionsWithMetrics !== 1 || sessionsTotal !== 1) {
    fail(`coverage ${sessionsWithMetrics}/${sessionsTotal}, expected 1/1`, analysis.stdout);
  }
  if (a.totals.requests !== expected) {
    fail(`analysis requests ${a.totals.requests}, expected ${expected}`, analysis.stdout);
  }
  if (a.dispatches.skipped !== 1) fail(`analysis skipped ${a.dispatches.skipped}`, analysis.stdout);
  const models = Object.keys(a.byModel);
  if (!models.some((m) => m.startsWith('claude-'))) fail('no model reached the analysis', analysis.stdout);

  process.stdout.write(
    `ANALYZE coverage=${sessionsWithMetrics}/${sessionsTotal} models=${models.sort().join(',')}\n`,
  );
} else if (phase === 'review-evidence-decides') {
  // EVIDENCE OUTRANKS PROSE. Two projects, one review file, byte for byte. One
  // has a host record of a real final reviewer and one has nothing but the
  // file; the verdicts must come out opposite.
  const createdAt = new Date(Date.now() - 3600_000).toISOString();
  const at = new Date(Date.now() - 60_000).toISOString();

  // --- the control, and it runs FIRST on purpose ------------------------
  // If this fixture's prose would read as `independent` anyway, the evidence
  // half proves nothing at all — it would pass whether or not the host record
  // decided anything. So measure the prose-only reading before measuring
  // anything else, through the shipped binary rather than by importing the
  // classifier, because the claim is about what an operator's forge does.
  makeProject(PROSE_PROJECT);
  const control = layerReviewFixture(PROSE_PROJECT, { createdAt });
  plantNoHostRecord();

  // The gate's own answer to this prose: a high-risk change whose only reader
  // was its author is refused. Same file that passes below.
  const refused = forge(PROSE_PROJECT, ['phase', 'done'], { CLAUDE_CONFIG_DIR: EMPTY_HOST_CFG });
  if (refused.code === 0) {
    fail(
      'the money/auth done gate ACCEPTED the prose-only fixture — its review file does not read as ' +
        'a self-check, so nothing below proves that evidence outranks prose',
      // Trimmed on purpose. `runE2eSteps` reports only the last 30 lines, and
      // `fail()` prints its message before its context — a passing `phase done`
      // emits the whole session JSON, which pushes the assertion off the top and
      // the operator sees no message at all. Reproduced by an independent
      // reviewer against two separate breaks.
      tail(refused.out, 8),
    );
  }
  if (!refused.out.includes('self-authored')) {
    fail('the gate refused the control for some other reason than a self-authored review', refused.out);
  }

  // Same run again with the refusal recorded, so the transition completes and
  // the prose-only verdict is written down where it can be read back.
  const waived = forge(
    PROSE_PROJECT,
    ['phase', 'done', '--final-review-waived', 'e2e control: measuring the prose-only reading'],
    { CLAUDE_CONFIG_DIR: EMPTY_HOST_CFG },
  );
  if (waived.code !== 0) fail(`control forge phase done exited ${waived.code}`, waived.out);
  const prose = frozenVerdictOf(control.sessionDir);
  if (!prose) fail('no verdict was frozen onto the control session', waived.out);
  if (prose.final !== 'self' || prose.evidence !== 'inferred') {
    fail(
      `THE CONTROL IS THE TEST: read as prose alone this review file gives ` +
        `${prose.final}/${prose.evidence}, not self/inferred. A fixture whose prose already reads as ` +
        'independent makes the evidence half below pass for free.',
      SELF_CHECK_REVIEW,
    );
  }

  // --- the same file, with a host record beside it ----------------------
  // Exactly the floor, not a comfortable margin above it: at the boundary this
  // fixture pins `<` rather than `<=`, which a margin would not. Tied to the
  // constant rather than fixed so the fixture cannot rot when the floor moves —
  // see the import comment for what that does and does not buy.
  const fixture = layerReviewFixture(SCRATCH, { createdAt, hostId: REVIEW_HOST_ID });
  plantReviewerDispatch(at, FINAL_REVIEW_REQUEST_FLOOR);
  const same =
    fs.readFileSync(path.join(fixture.sessionDir, 'reviews', 'final-review.md'), 'utf8') ===
    fs.readFileSync(path.join(control.sessionDir, 'reviews', 'final-review.md'), 'utf8');
  if (!same) {
    fail('the two projects no longer share one review file — the control says nothing about this one');
  }

  // No --allow-incomplete and no waiver: this is the real money/auth gate, on
  // a high-risk change whose review file says its author reviewed it.
  const done = forge(SCRATCH, ['phase', 'done'], { CLAUDE_CONFIG_DIR: REVIEW_HOST_CFG });
  if (done.code !== 0) {
    fail(
      'forge phase done refused a change whose host recorded a real final reviewer — the review ' +
        "file's prose was consulted after all",
      done.out,
    );
  }
  const verdict = frozenVerdictOf(fixture.sessionDir);
  if (!verdict) fail('no verdict was frozen onto the session', done.out);
  if (verdict.evidence !== 'host') {
    fail(`verdict graded ${verdict.evidence}, expected host — the dispatch record did not decide`, done.out);
  }
  if (verdict.final !== 'independent') {
    fail(`verdict ${verdict.final} on host evidence, expected independent`, done.out);
  }
  // Deliberately not asserting `stoppedByOperator` here. This fixture's meta
  // carries no `stoppedByUser`, so the flag is false by construction and the
  // assertion could never fail — hard-coding it in `review-census.mjs` left the
  // whole loop green. The declined-dispatch rule is covered by unit tests; it
  // has no step in this contract, and pretending otherwise is worse than the gap.

  // Derived, never spelled out: if an assertion above is ever loosened, the
  // gate's `expect` still catches the wrong answer at this line.
  process.stdout.write(
    `REVIEW final=${verdict.final} evidence=${verdict.evidence} ` +
      `prose=${prose.final === 'self' ? 'self-check' : prose.final}\n`,
  );
} else if (phase === 'review-evidence-substance') {
  // A DISPATCH IS NOT A REVIEW. Byte for byte the fixture `review-evidence-
  // decides` passes with, one thing changed: the reviewer on record made a
  // single request. That is the forgery this floor exists to end — a subagent
  // labelled `forge-review final <sessionId>` that read nothing certified a
  // review file which says in plain English that no subagent read the change,
  // and carried it through the money/auth gate.
  //
  // The host therefore may not answer, the prose must, and the prose says
  // self-check — which is what `review-evidence-decides`' control measures on
  // this same file, so all three assertions below are anchored to a reading
  // that step proves rather than to this one's say-so.
  const createdAt = new Date(Date.now() - 3600_000).toISOString();
  const at = new Date(Date.now() - 60_000).toISOString();

  // The fixture has to still straddle the floor. Nothing else here notices a
  // floor lowered to 1: the dispatch would clear it, the gate would pass, and
  // the failure would read as a product regression rather than as a step that
  // stopped describing a forgery.
  if (TOKEN_DISPATCH_REQUESTS >= FINAL_REVIEW_REQUEST_FLOOR) {
    fail(
      `this step plants a ${TOKEN_DISPATCH_REQUESTS}-request dispatch, which a floor of ` +
        `${FINAL_REVIEW_REQUEST_FLOOR} accepts — the fixture is no longer a forgery`,
    );
  }

  const fixture = layerReviewFixture(SCRATCH, { createdAt, hostId: REVIEW_HOST_ID });
  plantReviewerDispatch(at, TOKEN_DISPATCH_REQUESTS);

  const digestFile = path.join(SCRATCH, '.forge', 'sessions.jsonl');
  const ledgerBefore = JSON.stringify(lastDigest(digestFile));

  // The real gate: no --allow-incomplete, no waiver, a high-risk change.
  const refused = forge(SCRATCH, ['phase', 'done'], { CLAUDE_CONFIG_DIR: REVIEW_HOST_CFG });
  if (refused.code === 0) {
    // Trimmed for the runner's 30-line tail, as in the control above: a passing
    // `phase done` prints the whole session JSON and pushes this message out.
    fail(
      'the money/auth done gate ACCEPTED a change whose only reviewer on record made ' +
        `${TOKEN_DISPATCH_REQUESTS} request — a dispatch that read nothing certified the review`,
      tail(refused.out, 8),
    );
  }
  // WHY it refused, not merely that it did. A step that greps for a non-zero
  // exit passes against a gate refusing for an unrelated reason — a missing
  // verify-evidence file, an integrity failure — and would keep passing with
  // the floor deleted if anything else in the fixture ever broke.
  if (!refused.out.includes('self-authored')) {
    fail('the gate refused for some reason other than a self-authored final review', tail(refused.out, 20));
  }

  // AND NOTHING MOVED. `saveSession` runs last, after every gate's exit, so a
  // refusal that still transitioned the session or filed a durable line would
  // be the worse half of this defect: judged, refused, and recorded as done.
  const stalled = JSON.parse(fs.readFileSync(path.join(fixture.sessionDir, 'session.json'), 'utf8'));
  if (stalled.phase !== 'implement') {
    fail(`the refused gate transitioned the session anyway`, `phase = ${stalled.phase}`);
  }
  if (JSON.stringify(lastDigest(digestFile)) !== ledgerBefore) {
    fail('a refused gate wrote a durable ledger line', tail(refused.out, 8));
  }

  // Now record the refusal, so the transition completes and the verdict it
  // refused on lands where it can be read back — the same move the control in
  // `review-evidence-decides` makes, for the same reason: the refused pass
  // above never reached `saveSession`, so it froze nothing to disk.
  const waived = forge(
    SCRATCH,
    ['phase', 'done', '--final-review-waived', 'e2e substance: recording the refusal to read the verdict back'],
    { CLAUDE_CONFIG_DIR: REVIEW_HOST_CFG },
  );
  if (waived.code !== 0) fail(`forge phase done --final-review-waived exited ${waived.code}`, tail(waived.out, 8));
  const verdict = frozenVerdictOf(fixture.sessionDir);
  if (!verdict) fail('no verdict was frozen onto the session', tail(waived.out, 8));
  if (verdict.evidence !== 'inferred') {
    fail(
      `verdict graded ${verdict.evidence}, expected inferred — the host answered off a one-request ` +
        'dispatch instead of standing aside for the prose',
      JSON.stringify(verdict),
    );
  }
  if (verdict.final !== 'self') {
    fail(`verdict ${verdict.final} on prose evidence, expected self`, JSON.stringify(verdict));
  }

  process.stdout.write(
    `REVIEW final=${verdict.final} evidence=${verdict.evidence} ` +
      `gate=${refused.code === 0 ? 'accepted' : 'refused'}\n`,
  );
} else if (phase === 'review-evidence-survives') {
  // THE VERDICT OUTLIVES ITS EVIDENCE. The host prunes transcripts in days; the
  // durable digest is forever. Delete the record that decided, then make forge
  // re-derive everything that reads the verdict and prove nothing moved.
  const sessionDir = path.join(SCRATCH, '.forge', 'sessions', 's1');
  const digestFile = path.join(SCRATCH, '.forge', 'sessions.jsonl');
  const before = lastDigest(digestFile);
  if (!before) fail('no durable digest line — run review-evidence-decides first', digestFile);
  if (before.reviews?.final !== 'independent' || before.reviews?.evidence !== 'host') {
    // Only the reviews block: the whole digest entry is long enough to push
    // this message out of the runner's 30-line tail.
    fail(
      'the digest did not carry the measured verdict into this phase',
      JSON.stringify(before.reviews),
    );
  }
  if (typeof before.reviews?.rule !== 'number') {
    fail('the digest does not record which classifier judged it', JSON.stringify(before, null, 2));
  }

  const transcript = path.join(
    REVIEW_HOST_CFG,
    'projects',
    REVIEW_PROJECT_DIR,
    `${REVIEW_HOST_ID}.jsonl`,
  );
  if (!fs.existsSync(transcript)) fail('the host transcript was already gone before the prune', transcript);
  fs.rmSync(REVIEW_HOST_CFG, { recursive: true, force: true });
  if (fs.existsSync(transcript)) fail('the prune did not remove the host transcript', transcript);
  process.stdout.write(`PRUNED ${REVIEW_HOST_CFG}\n`);

  // 1. the gate. A second `forge phase done` now measures nothing, and must
  //    keep the answer it already has rather than falling back to the prose —
  //    which, per the control in the previous phase, says self-check.
  const again = forge(SCRATCH, ['phase', 'done'], { CLAUDE_CONFIG_DIR: REVIEW_HOST_CFG });
  if (again.code !== 0) {
    fail(
      'the money/auth gate refused a session whose evidence has been pruned — the verdict did not ' +
        'outlive it, and an operator would be asked to re-dispatch a reviewer that already ran',
      again.out,
    );
  }
  if (!again.out.includes('Kept the review verdict')) {
    fail('forge re-measured instead of keeping the frozen verdict', again.out);
  }
  // And it must still say so on disk: a pass that keeps the gate open but
  // degrades the stored verdict would strand every later reader.
  const kept = frozenVerdictOf(sessionDir);
  if (kept?.final !== 'independent' || kept?.evidence !== 'host') {
    fail('the verdict frozen on the session degraded once its evidence was pruned', JSON.stringify(kept));
  }

  // 2. the durable line. Delete it outright so `forge score --write` has to
  //    build it again from nothing, with no transcript left anywhere on disk.
  fs.rmSync(digestFile, { force: true });
  const scored = forge(SCRATCH, ['score', '--write'], { CLAUDE_CONFIG_DIR: REVIEW_HOST_CFG });
  /** @type {Record<string, any>} */
  let card;
  try {
    card = JSON.parse(scored.stdout);
  } catch {
    fail(`forge score printed no scorecard (exit ${scored.code})`, scored.out);
  }
  const after = lastDigest(digestFile);
  if (!after) fail('forge score --write did not re-derive the durable digest line', scored.out);

  // 3. the scorecard. Its 29-point money/auth cap reads the same verdict, and
  //    a live prose census here would both flip the note and apply the cap.
  const reviews = (card.checks ?? []).find((c) => c?.id === 'reviews');
  const notes = (reviews?.notes ?? []).join(' | ');
  if (!notes.includes('independent final review')) {
    fail('the scorecard fell back to the review file once the evidence was gone', notes);
  }
  const capText = (c) => (typeof c === 'string' ? c : (c?.text ?? ''));
  const cap = (card.caps ?? []).find((c) => capText(c).includes('self-authored'));
  if (cap) fail('the high-risk cap was applied to an independently reviewed session', capText(cap));

  const unchanged = JSON.stringify(after.reviews) === JSON.stringify(before.reviews);
  process.stdout.write(
    `DIGEST final=${after.reviews?.final} evidence=${after.reviews?.evidence} ` +
      `afterPrune=${unchanged ? 'unchanged' : 'changed'}\n`,
  );
  if (!unchanged) {
    fail(
      'the durable verdict moved once its evidence was pruned',
      `before ${JSON.stringify(before.reviews)}\nafter  ${JSON.stringify(after.reviews)}`,
    );
  }
} else if (phase === 'review-evidence-pruned-record') {
  // THE MOST DANGEROUS SHAPE THIS FLOOR CREATES — more dangerous than the
  // sibling above. `review-evidence-survives` deletes the whole host config, so
  // the host has no record at all and `reviewEvidence` answers `unavailable`;
  // the census then falls back to prose, which is safe by construction. This
  // step empties only the `subagents/` directory — deletes its files, KEEPS the
  // directory — which leaves the host perfectly readable and gives
  // `hostFinalReview` `seen === 0`, the one shape it cannot tell apart from "no
  // reviewer was ever dispatched". It answers with the one genuine negative in
  // that function: self/host. Before the keep rule read `unitOnRecord`
  // (F49/F52), that negative silently overwrote a frozen independent/inferred
  // verdict and the money/auth gate refused a change that really was
  // independently reviewed — permanently, because `saveSession` never runs
  // after `enforceFinalReviewFloor`'s `process.exit(1)`.
  //
  // The fixture has to straddle the floor exactly the way `review-evidence-
  // substance` does, guarded the same way for the same reason: nothing else in
  // this step would notice a floor lowered to 1, and the failure would then
  // read as a product regression instead of a fixture that stopped describing
  // a below-floor dispatch.
  if (TOKEN_DISPATCH_REQUESTS >= FINAL_REVIEW_REQUEST_FLOOR) {
    fail(
      `this step plants a ${TOKEN_DISPATCH_REQUESTS}-request dispatch, which a floor of ` +
        `${FINAL_REVIEW_REQUEST_FLOOR} accepts — the fixture no longer straddles the floor`,
    );
  }

  const createdAt = new Date(Date.now() - 3600_000).toISOString();
  const at = new Date(Date.now() - 60_000).toISOString();

  // Prose has to read INDEPENDENT here — the opposite of every other
  // review-evidence phase's fixture. `SELF_CHECK_REVIEW` would make the keep
  // rule's effect invisible: a re-graded self/host verdict would then refuse
  // for the ordinary reason (an unreviewed high-risk change), not because a
  // real reviewer's record was pruned.
  const fixture = layerReviewFixture(SCRATCH, { createdAt, hostId: REVIEW_HOST_ID });
  fs.writeFileSync(path.join(fixture.sessionDir, 'reviews', 'final-review.md'), INDEPENDENT_REVIEW, 'utf8');
  plantReviewerDispatch(at, TOKEN_DISPATCH_REQUESTS);

  // `finish` runs the identical freeze and the identical money/auth floor as
  // `done` (`freezeReviewVerdict`/`enforceFinalReviewFloor` in `set-phase.mjs`
  // both act on `phase !== 'done' && phase !== 'finish'`), so the below-floor
  // dispatch routes to prose here too — and independent prose clears the gate
  // outright, no waiver needed. That is exactly the spec's GIVEN: "one
  // unstopped final-review dispatch below the request floor, so the verdict
  // freezes as independent on inferred evidence with the unit on record".
  const finished = forge(SCRATCH, ['phase', 'finish'], { CLAUDE_CONFIG_DIR: REVIEW_HOST_CFG });
  if (finished.code !== 0) {
    fail(
      'forge phase finish refused a change whose review file reads independent and whose tasks/' +
        'evidence/spine are all in place — the fixture does not describe what this step needs',
      tail(finished.out, 20),
    );
  }

  // THIS IS WHAT THE LATER ASSERTIONS DEPEND ON. If `finish` did not freeze
  // exactly independent/inferred with the unit on record, the prune below
  // proves nothing — there would be no protected verdict for it to threaten.
  const frozen = frozenVerdictOf(fixture.sessionDir);
  if (!frozen) fail('no verdict was frozen at finish', tail(finished.out, 20));
  if (frozen.final !== 'independent' || frozen.evidence !== 'inferred') {
    fail(
      `finish froze ${frozen.final}/${frozen.evidence}, expected independent/inferred — either the ` +
        'prose did not read independent or the below-floor dispatch was graded host instead of ' +
        'routed to prose, and the rest of this step would be measuring the wrong thing',
      JSON.stringify(frozen),
    );
  }
  if (frozen.unitOnRecord !== true) {
    fail(
      'finish froze a verdict whose unitOnRecord is not true — the below-floor dispatch was still ON ' +
        'the host record at finish, so unitOnRecord has to be true for the prune below to be a real ' +
        'test of the keep rule rather than a case it was never asked to cover',
      JSON.stringify(frozen),
    );
  }

  // THE PRUNE. Delete the sidecar FILES, keep the DIRECTORY — the distinction
  // `review-evidence-survives` does not need to make, because it removes the
  // whole host config. Asserted both before and after, as that phase asserts
  // the transcript's presence and absence: a prune that did not prune would
  // turn this whole step into a tautology.
  const sidecarDir = path.join(REVIEW_HOST_CFG, 'projects', REVIEW_PROJECT_DIR, REVIEW_HOST_ID, 'subagents');
  const beforePrune = fs.readdirSync(sidecarDir);
  if (beforePrune.length === 0) {
    fail('the sidecar directory was already empty before the prune — nothing for this step to remove', sidecarDir);
  }
  for (const name of beforePrune) fs.rmSync(path.join(sidecarDir, name), { force: true });
  const afterPrune = fs.readdirSync(sidecarDir);
  if (afterPrune.length !== 0) {
    fail('the prune left files behind — a partial prune would not manufacture seen === 0', afterPrune.join(', '));
  }
  if (!fs.existsSync(sidecarDir)) {
    fail(
      'the prune removed the directory itself, not just its files — that is review-evidence-survives\' ' +
        'shape (host unavailable), not this one (host readable, answers "nothing was dispatched")',
      sidecarDir,
    );
  }
  process.stdout.write(`SIDECAR FILES PRUNED, DIRECTORY KEPT ${sidecarDir}\n`);

  // THE GATE. No --allow-incomplete and no waiver: this is the real money/auth
  // floor, on a high-risk change, with its final reviewer's dispatch record
  // just pruned. If the keep rule regresses to `frozen.evidence === 'host'`
  // alone (this task's negative control reverts exactly that line), this exits
  // non-zero with the gate's own self-authored refusal — and permanently,
  // because `saveSession` never runs after `process.exit(1)`. That is F49/F52
  // recurring.
  const done = forge(SCRATCH, ['phase', 'done'], { CLAUDE_CONFIG_DIR: REVIEW_HOST_CFG });
  if (done.code !== 0) {
    fail(
      'forge phase done refused a session whose final reviewer really ran, once its dispatch record ' +
        'was pruned rather than the transcript deleted outright — this is F49/F52 recurring: the keep ' +
        'rule stopped protecting a verdict frozen on inferred evidence',
      tail(done.out, 30),
    );
  }

  // THE VERDICT ON DISK, NOT MERELY A ZERO EXIT CODE. `done` can exit 0 for the
  // wrong reason (the gate skipped because risk facts were unreadable, a fresh
  // reading that happened to land on independent by coincidence); asserting the
  // exact frozen value is what rules those out.
  const kept = frozenVerdictOf(fixture.sessionDir);
  if (kept?.final !== 'independent' || kept?.evidence !== 'inferred') {
    fail(
      `the verdict on disk after done is ${kept?.final}/${kept?.evidence}, not the frozen ` +
        'independent/inferred — done passed for some reason other than keeping the measured verdict',
      JSON.stringify(kept),
    );
  }
  // AND THE GATE'S OWN SAY-SO. A `done` that passes for some other reason —
  // the floor skipped outright, the risk facts unreadable — must not be able to
  // satisfy this step merely by exiting 0 with the right value already on disk
  // from `finish`; the keep-rule note is what proves this *pass* is what kept it.
  if (!done.out.includes('Kept the review verdict')) {
    fail(
      'forge phase done did not print that it kept the review verdict already measured for this ' +
        'session — a done that passes for a different reason must not satisfy this step',
      tail(done.out, 20),
    );
  }

  // Derived, never spelled out: every field below is read back from the
  // session and the gate's own exit code, not asserted as a literal — a
  // hardcoded line here would keep printing this after the product broke.
  process.stdout.write(
    `PRUNED verdict=${kept.final}/${kept.evidence} gate=${done.code === 0 ? 'passed' : 'refused'} ` +
      `kept=${done.out.includes('Kept the review verdict') ? 'yes' : 'no'}\n`,
  );
} else if (phase === 'review-evidence-partial-binding') {
  // A BINDING READ IN PART MUST NOT DECIDE THE GATE. Before this fix,
  // `reviewEvidence` answered confidently off whichever half of a two-session
  // binding it could read: a session bound to two host sessions, one readable
  // and one not, reported `available: true` with `final` simply absent from
  // `units` — indistinguishable from "nobody dispatched a final reviewer" —
  // and the census graded that self/host. The money/auth gate then refused a
  // change whose final review genuinely happened, because the reviewer that
  // ran was dispatched in the unreachable half.
  //
  // THIS STEP IS INVERTED relative to every review-evidence sibling above: it
  // proves the gate now *accepts* something it used to refuse. A
  // refusal-shaped assertion would pass unchanged before and after the fix —
  // the acceptance is the only shape that tells the two apart.
  const createdAt = new Date(Date.now() - 3600_000).toISOString();
  const at1 = new Date(Date.now() - 90_000).toISOString();
  const at2 = new Date(Date.now() - 60_000).toISOString();

  // --- 1. the control, and it runs FIRST, exactly as review-evidence-decides'
  // does and for the same reason. `INDEPENDENT_REVIEW` is the opposite prose
  // of most other review-evidence steps' fixture (`SELF_CHECK_REVIEW`),
  // because what this step measures is host evidence going UNAVAILABLE — so
  // the fallback that has to decide is the prose reading independent on its
  // own. If this fixture's prose read anything else by itself, the
  // measurement below would pass regardless of whether the unreadable half
  // ever decided anything.
  makeProject(PROSE_PROJECT);
  const control = layerReviewFixture(PROSE_PROJECT, { createdAt });
  fs.writeFileSync(path.join(control.sessionDir, 'reviews', 'final-review.md'), INDEPENDENT_REVIEW, 'utf8');
  plantNoHostRecord();

  const controlDone = forge(PROSE_PROJECT, ['phase', 'done'], { CLAUDE_CONFIG_DIR: EMPTY_HOST_CFG });
  if (controlDone.code !== 0) {
    fail(
      'THE CONTROL IS THE TEST: the money/auth done gate REFUSED the prose-only fixture — this review ' +
        "file does not read independent on its own, so the measurement below would pass whether or not " +
        'the unreadable half decided anything',
      tail(controlDone.out, 8),
    );
  }
  const prose = frozenVerdictOf(control.sessionDir);
  if (!prose) fail('no verdict was frozen onto the control session', controlDone.out);
  if (prose.final !== 'independent' || prose.evidence !== 'inferred') {
    fail(
      `read as prose alone this review file gives ${prose.final}/${prose.evidence}, not ` +
        'independent/inferred — the measurement below would pass for the wrong reason',
      INDEPENDENT_REVIEW,
    );
  }

  // --- 2. the measurement: a session bound to TWO host sessions, the first
  // fully readable and carrying a real dispatch for a unit that is not
  // `final`, the second carrying the `final` dispatch with its host session
  // directory made unsearchable. Exactly the shape `review-evidence.test.mjs`
  // pins one layer down ("reviewEvidence stays unavailable when only one of
  // two bound host sessions can be searched") — this step drives the same
  // shape through the shipped binary instead of the module.
  const fixture = layerReviewFixture(SCRATCH, { createdAt, hostId: REVIEW_HOST_ID });
  fs.writeFileSync(path.join(fixture.sessionDir, 'reviews', 'final-review.md'), INDEPENDENT_REVIEW, 'utf8');

  // `layerReviewFixture` only takes one hostId; bind the second by hand — the
  // ordinary shape of a session resumed under a new host id, which `bindHost`
  // appends rather than replaces.
  const sessionFile = path.join(fixture.sessionDir, 'session.json');
  const boundSession = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  boundSession.host.sessionIds.push(REVIEW_HOST_ID_2);
  fs.writeFileSync(sessionFile, `${JSON.stringify(boundSession, null, 2)}\n`, 'utf8');

  // First half: fully readable, a genuine dispatch for a unit the gate is not
  // asking about. `reset: true` wipes REVIEW_HOST_CFG once, at the start of
  // this fixture — the only reset in this step.
  plantReviewerDispatch(at1, FINAL_REVIEW_REQUEST_FLOOR, {
    hostId: REVIEW_HOST_ID,
    description: IMPLEMENT_REVIEW_DISPATCH,
    reset: true,
  });
  // Second half: the final reviewer, planted beside the first rather than in
  // place of it (`reset: false`). Its request count clears
  // FINAL_REVIEW_REQUEST_FLOOR — imported, not hard-coded, so this fixture
  // moves with the floor rather than rotting under it, because assertion 3
  // below needs this exact dispatch to grade `host` once it can be read.
  // Consumed rather than recomputed: `hostDir`/`sidecarDir` come back off the
  // same write this call just did, so there is exactly one spelling of this
  // path in the step instead of two that could drift apart.
  const { hostDir: hostDir2, sidecarDir: sidecarDir2 } = plantReviewerDispatch(at2, FINAL_REVIEW_REQUEST_FLOOR, {
    hostId: REVIEW_HOST_ID_2,
    description: FINAL_REVIEW_DISPATCH,
    reset: false,
  });

  // A BACKSTOP, NOT A REPLACEMENT for the explicit restores below. Those cover
  // every `fail()` in this step's own control flow; this covers what they
  // cannot — an uncaught throw from a future edit to this block, or an
  // operator interrupting the multi-second `forge phase done` call below with
  // Ctrl-C. `process.exit()` skips `finally` (see the note below), but it
  // still fires the `exit` event, and so does an ordinary interpreter exit —
  // this is the one hook in Node that runs on both.
  process.on('exit', () => {
    try {
      fs.chmodSync(hostDir2, 0o755);
    } catch {
      // Already restored, or the directory is gone — either is fine here.
    }
  });

  // NOT a `try`/`finally`. `fail()` calls `process.exit()`, and `process.exit()`
  // terminates before any pending `finally` runs — proven against this very
  // file: `try { process.exit(1) } finally { console.log('x') }` prints
  // nothing. A `finally` here would therefore leave `hostDir2` at `000`
  // forever on the one path this step exists to exercise (a failing
  // assertion), breaking every later step in the loop with a failure that
  // reads as a product bug rather than housekeeping left undone here. So the
  // mode is restored explicitly, as an ordinary statement, before every
  // `fail()` call below rather than trusted to unwind on its own — and the
  // `exit` listener above is the backstop for whatever this still misses.
  fs.chmodSync(hostDir2, 0o000);

  // Proves the fixture is genuinely unreadable, and that the sibling
  // transcript is not. `chmod 000` on `subagents/` itself would not
  // reproduce this hole — `statSync` on a `000` directory still succeeds,
  // only `readdirSync` inside it fails, a different and already-fixed hole.
  // What reproduces this one is `chmod 000` one level up: the transcript
  // file stats fine, so the id binds, but `statSync` on `subagents/` inside
  // the now-unsearchable directory throws `EACCES`.
  let statErr = null;
  try {
    fs.statSync(sidecarDir2);
  } catch (err) {
    statErr = err;
  }
  if (!statErr || statErr.code !== 'EACCES') {
    fs.chmodSync(hostDir2, 0o755);
    fail(
      'the chmod did not make the second host session directory unsearchable — this fixture is not ' +
        'testing what it claims to',
      `stat ${sidecarDir2}: ${statErr ? statErr.code : 'did not throw'}`,
    );
  }
  if (!fs.statSync(path.join(hostDir2, '..', `${REVIEW_HOST_ID_2}.jsonl`)).isFile()) {
    fs.chmodSync(hostDir2, 0o755);
    fail('the sibling transcript is not readable either — this fixture no longer isolates the sidecar', hostDir2);
  }

  // No --allow-incomplete and no waiver: the real money/auth gate, on a
  // high-risk change bound to a partly-unreadable pair of host sessions.
  const done = forge(SCRATCH, ['phase', 'done'], { CLAUDE_CONFIG_DIR: REVIEW_HOST_CFG });
  // Restored the moment the gate has run, unconditionally — nothing below
  // this line needs the directory blocked, and every `fail()` from here on
  // must fire with the mode already sane.
  fs.chmodSync(hostDir2, 0o755);
  if (done.code !== 0) {
    // Trimmed for the runner's 30-line tail, as every other review-evidence
    // step's refusal-shaped assertion does: a passing `phase done` prints
    // the whole session JSON and would push this message off the top.
    fail(
      'forge phase done refused a change whose final reviewer genuinely ran, once the host session ' +
        "carrying that reviewer's record became unreadable — the readable half answered confidently " +
        'instead of the whole binding standing aside for the prose',
      tail(done.out, 8),
    );
  }
  const verdict = frozenVerdictOf(fixture.sessionDir);
  if (!verdict) fail('no verdict was frozen onto the session', tail(done.out, 8));
  if (verdict.final !== 'independent') {
    fail(`verdict ${verdict.final} on ${verdict.evidence} evidence, expected independent`, JSON.stringify(verdict));
  }
  // THE LOAD-BEARING HALF OF THIS STEP. `independent` alone is also produced
  // by a fixture whose evidence never had anything to say; `inferred` is
  // what proves the host *could not* answer rather than *chose* this answer.
  // `host` here would mean the readable half decided on its own — the exact
  // defect this step exists to catch.
  if (verdict.evidence !== 'inferred') {
    fail(
      `verdict graded ${verdict.evidence}, expected inferred — the readable half answered on its own ` +
        'instead of the whole binding standing aside for the prose',
      JSON.stringify(verdict),
    );
  }

  // --- 3. the counter-fixture — this is what makes the step mean something.
  // Same session, same fixture; the only variable changed is readability,
  // just restored above. Now the binding is fully readable end to end, the
  // final dispatch in the second half is visible, and the verdict must come
  // out `host`: proof that the second half genuinely carries the final
  // reviewer and that readability alone decided the shape of assertion 2.
  // Without this, a fixture whose second half was empty or misplanted would
  // also produce `inferred`, for a trivial reason, and assertion 2 would
  // prove nothing.
  //
  // Reruns the SAME session `forge phase done` already transitioned above —
  // the move `review-evidence-survives` makes for the same reason — rather
  // than a fresh one, and that is a considered choice, not an oversight.
  // `freezeReviewVerdict` (set-phase.mjs) freezes `unitOnRecord` alongside
  // the verdict: whether *that* pass actually saw the `final` unit on the
  // host record. Assertion 2 above froze `unitOnRecord: false`, because the
  // whole point of that pass is that the `final` unit could not be seen at
  // all. The keep rule's `measured` test reads
  // `frozen.final === 'independent' && (frozen.unitOnRecord ?? frozen.evidence === 'host')`
  // — with `unitOnRecord` present and `false`, the `??` never falls through
  // to the older `evidence === 'host'` test, so `measured` is `false` and
  // this pass re-measures instead of keeping the stale `inferred` grade. A
  // fresh session is not needed for that, and manufacturing one here would
  // hide the exact case this field exists to distinguish from the F49/F52
  // shape `review-evidence-pruned-record` covers, where the unit WAS on
  // record and the keep rule must instead hold the line.
  const reread = forge(SCRATCH, ['phase', 'done'], { CLAUDE_CONFIG_DIR: REVIEW_HOST_CFG });
  if (reread.code !== 0) {
    fail(
      'forge phase done refused the identical fixture once the second host session became readable ' +
        'again — restoring readability must never turn an accepted change into a refused one',
      tail(reread.out, 8),
    );
  }
  const rereadVerdict = frozenVerdictOf(fixture.sessionDir);
  if (!rereadVerdict) fail('no verdict was frozen onto the session on the reread pass', tail(reread.out, 8));
  if (rereadVerdict.final !== 'independent') {
    fail(`verdict ${rereadVerdict.final} on host evidence, expected independent`, JSON.stringify(rereadVerdict));
  }
  if (rereadVerdict.evidence !== 'host') {
    fail(
      `verdict graded ${rereadVerdict.evidence}, expected host once the binding was fully readable — ` +
        "either the second half's dispatch does not genuinely carry the final reviewer, or the keep " +
        'rule kept a stale grade it should have refreshed',
      JSON.stringify(rereadVerdict),
    );
  }

  // Derived, never spelled out beyond the one field the spec's own words fix:
  // `binding=half-read` and `gate=accepted` name the shape this step proves,
  // not a measurement, and `evidence` is read back from assertion 2's own
  // verdict rather than hard-coded, so a regression there still shows up here.
  process.stdout.write(`PARTIAL binding=half-read gate=accepted evidence=${verdict.evidence}\n`);
} else if (phase === 'review-stamp-decides') {
  // THE STAMP IS THE VARIABLE. This step drives the chain
  // `review-label-cli.mjs` → `review-stamp.mjs` → (host record absent, then
  // planted below the floor) → `review-census.mjs` → `set-phase.mjs`'s
  // money/auth gate, through the shipped binary, three times over ONE session —
  // and between each pair of runs exactly one thing changes.
  //
  // ONE SESSION RATHER THAN TWO PROJECTS, unlike `review-evidence-decides`,
  // and deliberately. That step's variable is a host record, which lives
  // outside the project and can therefore be given to one copy and withheld
  // from another. This step's variable is a file INSIDE the session directory,
  // written by a command that has to run in the project it is stamping. Two
  // projects would have made "the stamp" and "the project" vary together, and
  // no assertion here could then tell which one flipped the gate. Re-running
  // the same session is the harness's established move for that
  // (`review-evidence-survives`, `review-evidence-partial-binding`'s
  // counter-fixture), and the freeze's keep rule permits it: nothing this step
  // freezes is `independent` with `unitOnRecord` true, so every pass
  // re-measures rather than keeping a stale grade.
  const createdAt = new Date(Date.now() - 3600_000).toISOString();
  const at = new Date(Date.now() - 60_000).toISOString();

  const fixture = layerReviewFixture(SCRATCH, { createdAt, hostId: REVIEW_HOST_ID });
  const reviewFile = path.join(fixture.sessionDir, 'reviews', 'final-review.md');
  const digestFile = path.join(SCRATCH, '.forge', 'sessions.jsonl');
  // The session id the stamp has to name, read off the session rather than
  // spelled out: `stampedFinalReview` compares the stamp's `sessionId` against
  // the session directory's own basename, and a literal here would still match
  // if both drifted.
  const sessionId = JSON.parse(fs.readFileSync(path.join(fixture.sessionDir, 'session.json'), 'utf8')).id;

  // THE PRUNE, AND IT HAPPENS BEFORE THE CONTROL. The spec's GIVEN is a session
  // "whose host transcript has since been pruned from disk" — *since*, so the
  // record has to have existed. Planted at full substance (it would have
  // cleared the floor and graded `host`) and then removed outright, so what the
  // control and the stamped run below both face is a genuine pruned residual:
  // `reviewEvidence` answers unavailable ("no transcript on disk … pruned or
  // written elsewhere") and the host cannot speak for either of them.
  const planted = plantReviewerDispatch(at, FINAL_REVIEW_REQUEST_FLOOR);
  const transcript = path.join(planted.projectDir, `${REVIEW_HOST_ID}.jsonl`);
  if (!fs.existsSync(transcript)) fail('the host record was never planted, so nothing is being pruned', transcript);
  unlockTree(REVIEW_HOST_CFG);
  fs.rmSync(REVIEW_HOST_CFG, { recursive: true, force: true });
  if (fs.existsSync(transcript)) fail('the prune did not remove the host transcript', transcript);
  process.stdout.write(`PRUNED ${REVIEW_HOST_CFG}\n`);

  // --- 1. the control, and it runs FIRST, for the reason the comment in
  // `review-evidence-partial-binding` gives and `review-evidence-decides`
  // gives before it. The stamped run below is the identical session with the
  // identical file and the identical pruned host; if this fixture already
  // cleared the money/auth gate, that run would prove nothing about the stamp,
  // because it would have passed with or without one.
  const { file: stampFile, doc: noStamp } = stampsOf(fixture.sessionDir);
  if (noStamp !== null) {
    fail(
      'a dispatch stamp already exists before `forge review-label` has been run — the control is not ' +
        'the unstamped half of this comparison',
      stampFile,
    );
  }

  const refused = forge(SCRATCH, ['phase', 'done'], { CLAUDE_CONFIG_DIR: REVIEW_HOST_CFG });
  if (refused.code === 0) {
    // Trimmed for the runner's 30-line tail, as every refusal-shaped assertion
    // in this file is: a passing `phase done` prints the whole session JSON and
    // would push this message off the top.
    fail(
      'THE CONTROL IS THE TEST: the money/auth done gate ACCEPTED an unstamped, unreviewed, high-risk ' +
        'change — the stamped run below would then pass whether or not the stamp decided anything',
      tail(refused.out, 8),
    );
  }
  // WHY it refused, not merely that it did. A step that greps for a non-zero
  // exit passes against a gate refusing for an unrelated reason — a missing
  // verify-evidence file, an integrity failure — and would keep passing with
  // the whole floor deleted.
  if (!refused.out.includes('self-authored')) {
    fail('the gate refused the control for some reason other than a self-authored final review', tail(refused.out, 20));
  }

  // Record the refusal so the transition completes and the verdict it refused
  // on lands where it can be read back — the move `review-evidence-decides`'
  // control and `review-evidence-substance` both make, for the same reason:
  // the refused pass exits before `saveSession`, so it freezes nothing.
  const waived = forge(
    SCRATCH,
    ['phase', 'done', '--final-review-waived', 'e2e control: measuring the unstamped reading'],
    { CLAUDE_CONFIG_DIR: REVIEW_HOST_CFG },
  );
  if (waived.code !== 0) fail(`control forge phase done exited ${waived.code}`, tail(waived.out, 8));
  const prose = frozenVerdictOf(fixture.sessionDir);
  if (!prose) fail('no verdict was frozen onto the control run', tail(waived.out, 8));
  if (prose.final !== 'self' || prose.evidence !== 'inferred') {
    fail(
      `THE CONTROL IS THE TEST: unstamped, with the host pruned, this session reads ` +
        `${prose.final}/${prose.evidence}, not self/inferred. A fixture that already reads independent — ` +
        'or one whose host still answers — makes the stamped run below pass for free.',
      SELF_CHECK_REVIEW,
    );
  }

  // --- 2. the stamp, and it is the ONLY thing that changes. Run the real
  // command; assert its artefact; change nothing else.
  const label = forge(SCRATCH, ['review-label', 'final'], { CLAUDE_CONFIG_DIR: REVIEW_HOST_CFG });
  if (label.code !== 0) fail(`forge review-label final exited ${label.code}`, tail(label.out, 20));
  // BYTE-IDENTICAL ON STDOUT. This string is dispatched as a Task description
  // and matched back character for character by `reviewEvidence`; a stray
  // advisory line on stdout makes every copy-pasted dispatch unattributable.
  // The command writes its notes to stderr precisely so this holds, and
  // `forge()` keeps the two streams apart so this can be asserted.
  const expectedLabel = `forge-review final ${sessionId}\n`;
  if (label.stdout !== expectedLabel) {
    fail(
      `forge review-label final printed ${JSON.stringify(label.stdout)} on stdout, expected exactly ` +
        `${JSON.stringify(expectedLabel)}`,
      tail(label.out, 20),
    );
  }

  const { doc: stamped } = stampsOf(fixture.sessionDir);
  if (stamped === null) fail('forge review-label final wrote no dispatch stamp', stampFile);
  if (!Array.isArray(stamped.stamps) || stamped.stamps.length !== 1) {
    fail(
      `the stamp file holds ${Array.isArray(stamped.stamps) ? stamped.stamps.length : 'no'} stamps, expected 1`,
      JSON.stringify(stamped),
    );
  }
  const stamp = stamped.stamps[0];
  if (stamp.unit !== 'final') fail(`the stamp records unit ${JSON.stringify(stamp.unit)}, expected final`, JSON.stringify(stamp));
  // The copy guard, and the reason a stamp cannot certify every directory it is
  // copied into: the census compares this field against the session directory's
  // own name. A stamp naming another session decides nothing.
  if (stamp.sessionId !== sessionId) {
    fail(`the stamp names session ${JSON.stringify(stamp.sessionId)}, expected ${sessionId}`, JSON.stringify(stamp));
  }
  // The stamp's own copy of what stdout said, so a reviewer dispatched from
  // this label can be joined back to the record of it being issued.
  if (`${stamp.label}\n` !== expectedLabel) {
    fail(`the stamp records label ${JSON.stringify(stamp.label)}, expected ${JSON.stringify(expectedLabel.trim())}`, JSON.stringify(stamp));
  }
  if (typeof stamp.at !== 'string' || !stamp.at) fail('the stamp carries no timestamp', JSON.stringify(stamp));
  // The model is informative context, never load-bearing for the gate — but it
  // is resolved in-process at the reviewer's tier, and a `null` here means the
  // resolver failed and the stamp records nothing about what would have run.
  if (!stamp.model || typeof stamp.model !== 'object' || !stamp.model.tier) {
    fail(
      'the stamp carries no resolved model with a tier — `forge review-label` resolved the reviewer ' +
        'model at dispatch time and lost it',
      JSON.stringify(stamp),
    );
  }

  // AND NOTHING ELSE MOVED. Both halves of this are load-bearing: a review file
  // rewritten between the two runs would flip the prose rule on its own, and a
  // host record that came back would grade `host` rather than `recorded` —
  // either would let this step pass with the stamp doing nothing.
  if (fs.readFileSync(reviewFile, 'utf8') !== SELF_CHECK_REVIEW) {
    fail('the review file changed between the control and the stamped run — the stamp is not the variable', reviewFile);
  }
  if (fs.existsSync(REVIEW_HOST_CFG)) {
    fail('a host record reappeared after the prune — the stamp is not the variable', REVIEW_HOST_CFG);
  }

  // The real money/auth gate: no --allow-incomplete, no waiver, a high-risk
  // change whose review file still says in plain English that its author wrote
  // it. The only thing that has happened since the control refused is the file
  // asserted above.
  const done = forge(SCRATCH, ['phase', 'done'], { CLAUDE_CONFIG_DIR: REVIEW_HOST_CFG });
  if (done.code !== 0) {
    fail(
      'forge phase done refused a session whose final reviewer was stamped at dispatch time and whose ' +
        'host transcript has since been pruned — the pruned transcript still erases the reviewer',
      tail(done.out, 20),
    );
  }
  const verdict = frozenVerdictOf(fixture.sessionDir);
  if (!verdict) fail('no verdict was frozen onto the stamped run', tail(done.out, 8));
  if (verdict.final !== 'independent') {
    fail(`verdict ${verdict.final} on ${verdict.evidence} evidence, expected independent`, JSON.stringify(verdict));
  }
  // THE LOAD-BEARING HALF. `independent` alone is also what a review file whose
  // prose happened to read independent produces, and `host` would mean a
  // dispatch record answered after all. `recorded` is the one grade that says
  // THE STAMP decided — the whole claim of this step.
  if (verdict.evidence !== 'recorded') {
    fail(
      `verdict graded ${verdict.evidence}, expected recorded — the stamp is not what carried this ` +
        'session through the gate',
      JSON.stringify(verdict),
    );
  }
  // AND IT REACHED THE DURABLE LINE. The session directory is deleted by
  // `forge cleanup`; `.forge/sessions.jsonl` is what outlives it, and a verdict
  // that decided a gate but never landed there is unauditable afterwards.
  const digest = lastDigest(digestFile);
  if (digest?.reviews?.final !== 'independent' || digest?.reviews?.evidence !== 'recorded') {
    fail(
      'the durable digest line did not carry the stamped verdict',
      JSON.stringify(digest?.reviews),
    );
  }

  // --- 3. the D3 guard, and it is what stops this whole mechanism from
  // reopening F33. Same session, same stamp, same review file; the one thing
  // that changes is that the host now has a WELL-FORMED `final` bucket whose
  // busiest unstopped dispatch made one request — the token-dispatch forgery
  // `review-evidence-substance` closed. That `null` is the one the host
  // *measured*, so the stamp must not answer over it: the forger runs
  // `forge review-label` too, and a stamp written before the token dispatch
  // even existed would hand the forgery its `independent` straight back.
  //
  // The fixture has to still straddle the floor, guarded exactly as
  // `review-evidence-substance` and `review-evidence-pruned-record` guard
  // theirs: nothing else here would notice a floor lowered to 1, and the
  // failure would then read as a product regression rather than as a fixture
  // that stopped describing a forgery.
  if (TOKEN_DISPATCH_REQUESTS >= FINAL_REVIEW_REQUEST_FLOOR) {
    fail(
      `this step plants a ${TOKEN_DISPATCH_REQUESTS}-request dispatch, which a floor of ` +
        `${FINAL_REVIEW_REQUEST_FLOOR} accepts — the fixture is no longer a forgery`,
    );
  }
  plantReviewerDispatch(at, TOKEN_DISPATCH_REQUESTS);
  const beforeSubfloor = JSON.stringify(lastDigest(digestFile));

  const subfloor = forge(SCRATCH, ['phase', 'done'], { CLAUDE_CONFIG_DIR: REVIEW_HOST_CFG });
  if (subfloor.code === 0) {
    fail(
      'the money/auth done gate ACCEPTED a stamped session whose only reviewer on record made ' +
        `${TOKEN_DISPATCH_REQUESTS} request — the stamp resurrected the token-dispatch forgery`,
      tail(subfloor.out, 8),
    );
  }
  if (!subfloor.out.includes('self-authored')) {
    fail('the gate refused the sub-floor run for some reason other than a self-authored final review', tail(subfloor.out, 20));
  }
  // AND THE STAMP IS STILL THERE. Without this, a refusal caused by the stamp
  // file having been lost or overwritten between runs would satisfy the
  // assertion above, and the step would be proving the wrong thing entirely.
  const { doc: stillStamped } = stampsOf(fixture.sessionDir);
  if (!stillStamped?.stamps?.some((s) => s.unit === 'final' && s.sessionId === sessionId)) {
    fail(
      'the final-unit stamp is gone by the sub-floor run — this refusal is the stamp missing, not the ' +
        'floor holding',
      JSON.stringify(stillStamped),
    );
  }
  // AND NOTHING MOVED. `saveSession` runs after every gate's exit, so a refusal
  // that still filed a durable line would be the worse half of this defect:
  // judged, refused, and recorded as done anyway.
  if (JSON.stringify(lastDigest(digestFile)) !== beforeSubfloor) {
    fail('the refused sub-floor gate wrote a durable ledger line', tail(subfloor.out, 8));
  }

  // Record that refusal too, so the verdict it refused on can be read back —
  // and it must be the PROSE's reading, `self`/`inferred`, not the `recorded`
  // grade the same stamp earned two runs ago. That is the difference between
  // "the gate refused" and "the stamp was kept out of a measurement the host
  // made".
  const subfloorWaived = forge(
    SCRATCH,
    ['phase', 'done', '--final-review-waived', 'e2e subfloor: recording the refusal to read the verdict back'],
    { CLAUDE_CONFIG_DIR: REVIEW_HOST_CFG },
  );
  if (subfloorWaived.code !== 0) fail(`forge phase done --final-review-waived exited ${subfloorWaived.code}`, tail(subfloorWaived.out, 8));
  const subfloorVerdict = frozenVerdictOf(fixture.sessionDir);
  if (subfloorVerdict?.final !== 'self' || subfloorVerdict?.evidence !== 'inferred') {
    fail(
      `the sub-floor run froze ${subfloorVerdict?.final}/${subfloorVerdict?.evidence}, expected ` +
        'self/inferred — the verdict did not route to the review file\'s prose, so the stamp answered ' +
        'over a bucket the host measured',
      JSON.stringify(subfloorVerdict),
    );
  }

  // Derived, never spelled out: every field is read back from the session, the
  // durable digest and the gates' own exit codes, so a loosened assertion above
  // still shows up as the wrong answer on this line — which is what the step's
  // `expect` in e2e.json matches.
  process.stdout.write(
    `REVIEW stamped final=${verdict.final} evidence=${verdict.evidence} ` +
      `gate=${done.code === 0 ? 'passed' : 'refused'}; ` +
      `control final=${prose.final} evidence=${prose.evidence} ` +
      `gate=${refused.code === 0 ? 'passed' : 'refused'}; ` +
      `subfloor gate=${subfloor.code === 0 ? 'passed' : 'refused'}\n`,
  );
} else if (phase === 'session-ambiguity') {
  // THE REGRESSION THAT MUST NEVER COME BACK. `.forge/active.json` is written by
  // `forge new` alone, so "active" means *most recently created*. Before this
  // change, a bare `forge phase done` with two sessions open gated whichever one
  // the pointer happened to name: it scored that change, wrote its permanent
  // ledger line, and left the other — the one actually being finished — with no
  // verdict, no scorecard and no trip through the money/auth floor at all.
  //
  // The severity split is the operator's: `done`/`finish` refuse because their
  // damage is unrecoverable; every other phase warns and carries on, because
  // being wrong at `implement` costs a re-run and refusing there would block
  // ordinary work in any project with two sessions open.
  const project = makeProject(`${SCRATCH}-ambiguity`);
  const second = path.join(project, '.forge', 'sessions', 's2');
  fs.mkdirSync(second, { recursive: true });
  fs.writeFileSync(
    path.join(second, 'session.json'),
    `${JSON.stringify({ id: 's2', slug: 'neighbour', phase: 'implement' })}\n`,
  );

  const gated = forge(project, ['phase', 'done']);
  if (gated.code === 0) {
    fail(
      'forge phase done picked a session for itself with two open',
      'this is the defect: it scores and files whichever the pointer names, and the other change never reaches the floor',
    );
  }
  for (const needle of ['Refusing to guess', '--session s1', '--session s2']) {
    if (!gated.out.includes(needle)) {
      fail(`the refusal did not name ${needle}`, tail(gated.out, 20));
    }
  }
  // And it must have changed nothing at all.
  if (fs.existsSync(path.join(project, '.forge', 'sessions.jsonl'))) {
    fail('a refused gate wrote a durable ledger line');
  }
  if (fs.existsSync(path.join(project, '.forge', 'sessions', 's1', 'scorecard.json'))) {
    fail('a refused gate wrote a scorecard');
  }

  // A reversible phase is deliberately NOT refused. `verify` rather than
  // `implement` because implement has its own brief gate, and a refusal from
  // that would look identical to the one under test.
  const soft = forge(project, ['phase', 'verify']);
  if (soft.code !== 0) {
    fail('a reversible phase refused instead of warning', tail(soft.out, 20));
  }
  if (!soft.out.includes('sessions are unfinished')) {
    fail('a reversible phase proceeded silently', tail(soft.out, 20));
  }

  // AND IT MUST HAVE ACTED ON THE POINTER'S SESSION, NOT THE OTHER ONE. Warning
  // about ambiguity and then transitioning the neighbour is the original defect
  // wearing a diagnostic. Checked here because the loop asserted the *refuse*
  // side and merely that the *warn* side warned — a mutant that warned and then
  // acted on the wrong session shipped this loop green.
  const s1 = JSON.parse(
    fs.readFileSync(path.join(project, '.forge', 'sessions', 's1', 'session.json'), 'utf8'),
  );
  const s2 = JSON.parse(
    fs.readFileSync(path.join(project, '.forge', 'sessions', 's2', 'session.json'), 'utf8'),
  );
  if (s1.phase !== 'verify') {
    fail('the warn path did not transition the session active.json names', `s1.phase = ${s1.phase}`);
  }
  if (s2.phase !== 'implement') {
    fail('the warn path transitioned the neighbour', `s2.phase = ${s2.phase}`);
  }

  process.stdout.write(
    `AMBIGUITY done=refused verify=warned+acted-on-s1 neighbour=untouched candidates=2\n`,
  );
} else if (phase === 'doctor-wiring') {
  // THE VOLO FAILURE MODE, END TO END, AGAINST THE SHIPPED BINARY. A project
  // with forge hooks on disk but only a non-forge hook wired must fail
  // `forge doctor`, naming exactly the unwired forge basenames and the
  // snippet an operator merges to fix it; wiring those basenames must flip
  // it green. A stub doctor that always exits 0 fails the RED assertions
  // below; one that always exits 1 fails the GREEN ones — the red→green pair
  // is what proves this phase discriminates rather than merely running.
  const dir = makeDoctorWiringProject(DOCTOR_WIRING_PROJECT);
  const expectedUnwired = [...DOCTOR_FORGE_HOOKS].sort();

  // --- RED: only the non-forge hook is wired ------------------------------
  writeDoctorWiring(dir, [DOCTOR_NON_FORGE_HOOK]);

  const red = forge(dir, ['doctor', '--json']);
  if (red.code !== 1) fail(`doctor --json exited ${red.code} against an unwired fixture, expected 1`, red.out);
  let redReport;
  try {
    redReport = JSON.parse(red.stdout);
  } catch {
    fail('doctor --json printed no parseable JSON on the red run', red.out);
  }
  if (redReport.checks?.hooks?.ok !== false) {
    fail(
      'checks.hooks.ok was not false against a project with unwired forge hooks',
      JSON.stringify(redReport.checks?.hooks),
    );
  }
  const claudeSurface = (redReport.checks.hooks.surfaces ?? []).find((s) => s.surface === 'claude');
  if (!claudeSurface) fail('no claude surface reported by checks.hooks', JSON.stringify(redReport.checks.hooks));
  const unwired = [...(claudeSurface.unwired ?? [])].sort();
  if (JSON.stringify(unwired) !== JSON.stringify(expectedUnwired)) {
    fail(
      `claude surface unwired ${JSON.stringify(unwired)}, expected exactly ${JSON.stringify(expectedUnwired)}`,
      JSON.stringify(claudeSurface, null, 2),
    );
  }
  if (!redReport.checks.hooks.message.includes('forge-hooks.snippet.json')) {
    fail('doctor --json message did not name forge-hooks.snippet.json', redReport.checks.hooks.message);
  }

  // The human-facing surface, not just --json: a `[FAIL]` line naming one of
  // the unwired basenames — the operator reads this, not the JSON.
  const redHuman = forge(dir, ['doctor']);
  if (redHuman.code !== 1) fail(`doctor (human) exited ${redHuman.code} against the same fixture, expected 1`, redHuman.out);
  const failLine = redHuman.stdout
    .split('\n')
    .find((line) => line.includes('[FAIL]') && expectedUnwired.some((name) => line.includes(name)));
  if (!failLine) fail('no [FAIL] line named an unwired forge hook basename', redHuman.stdout);

  // --- FIX: every forge hook basename now appears in a hook command -------
  writeDoctorWiring(dir, [DOCTOR_NON_FORGE_HOOK, ...DOCTOR_FORGE_HOOKS]);

  const green = forge(dir, ['doctor', '--json']);
  if (green.code !== 0) fail(`doctor --json exited ${green.code} once every forge hook was wired, expected 0`, green.out);
  let greenReport;
  try {
    greenReport = JSON.parse(green.stdout);
  } catch {
    fail('doctor --json printed no parseable JSON on the green run', green.out);
  }
  if (greenReport.checks?.hooks?.ok !== true) {
    fail(
      'checks.hooks.ok was not true once every forge hook basename was wired',
      JSON.stringify(greenReport.checks?.hooks),
    );
  }

  process.stdout.write('DOCTOR WIRING GREEN\n');
} else if (phase === 'test-guard') {
  // THE F74 HALF, AGAINST THE SHIPPED BINARY: a fresh project has no
  // `.claude/settings.json` at all; `forge init` must structurally merge the
  // hooks snippet into one (including the `forge-test-guard.mjs` hook this
  // whole loop is about), and `forge doctor` must then read the project as
  // fully wired — the same claim `doctor-wiring` proves for a hand-built
  // fixture, proved here for what `forge init` itself produces.
  const dir = TEST_GUARD_PROJECT;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const init = forge(dir, ['init', '--claude', '--no-openspec', '--no-adr']);
  if (init.code !== 0) fail(`forge init exited ${init.code} on a fresh project`, init.out);

  const settingsPath = path.join(dir, '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    fail('forge init did not create .claude/settings.json', init.out);
  }
  const settingsText = fs.readFileSync(settingsPath, 'utf8');
  if (!settingsText.includes('forge-test-guard.mjs')) {
    fail('the merged settings.json does not reference forge-test-guard.mjs', settingsText);
  }

  const doctorAfterInit = forge(dir, ['doctor']);
  if (doctorAfterInit.code !== 0) {
    fail('forge doctor did not exit 0 once forge init had wired the hooks', doctorAfterInit.out);
  }
  process.stdout.write('INIT+DOCTOR GREEN (F74)\n');

  // --- now the guard itself: a real git repo, three baseline test files ---
  // (`foo` denied then allowanced, `bar` tampered by modification, `baz`
  // tampered by deletion) and one created after the commit (`new`, which
  // must read as unguarded no matter how it matches the glob).
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'e2e@example.com');
  git(dir, 'config', 'user.name', 'E2E Harness');
  const srcDir = path.join(dir, 'packages', 'cli', 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  const fooTest = path.join(srcDir, 'foo.test.mjs');
  const barTest = path.join(srcDir, 'bar.test.mjs');
  const bazTest = path.join(srcDir, 'baz.test.mjs');
  fs.writeFileSync(fooTest, 'baseline foo\n', 'utf8');
  fs.writeFileSync(barTest, 'baseline bar\n', 'utf8');
  fs.writeFileSync(bazTest, 'baseline baz\n', 'utf8');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  const baseCommit = git(dir, 'rev-parse', 'HEAD');
  // Created AFTER the commit: untracked at baseCommit, so it must read as
  // unguarded even though it matches the same glob as the baseline files.
  fs.writeFileSync(path.join(srcDir, 'new.test.mjs'), 'new during session\n', 'utf8');

  const sessionDir = path.join(dir, '.forge', 'sessions', 's1');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify({ id: 's1', slug: 'guard-fixture', phase: 'implement', baseCommit })}\n`,
  );
  fs.writeFileSync(path.join(dir, '.forge', 'active.json'), `${JSON.stringify({ sessionId: 's1' })}\n`);
  // notApplicable spine: this loop measures the guard, not the E2E gate, and
  // it is what makes a clean `forge integrity-check` read ok:true below —
  // isolating the guarded-files finding as the only thing that can flip it.
  fs.writeFileSync(
    path.join(sessionDir, 'spine.json'),
    `${JSON.stringify({ notApplicable: 'test-guard e2e fixture — no runtime spine' }, null, 2)}\n`,
  );

  // --- F79, AGAINST THE SHIPPED BINARY: the UserPromptSubmit hook `forge
  // init` just installed above never lets a shell metacharacter in the
  // prompt execute. Drive that exact installed file (not a copy) over
  // stdin, with a real `forge` — a relay onto the SHIPPED FORGE_BIN, not a
  // stub — first on PATH, so the hook's real spawn site is what runs.
  const promptHookPath = path.join(dir, '.claude', 'hooks', 'forge-prompt-hook.mjs');
  if (!fs.existsSync(promptHookPath)) {
    fail('forge init did not install .claude/hooks/forge-prompt-hook.mjs', init.out);
  }
  const injectionMarker = path.join(dir, '.forge', 'f79-injection-marker');
  const forgeRelayDir = path.join(dir, '.forge', 'f79-forge-relay');
  const forgeRelayLog = path.join(forgeRelayDir, 'calls.jsonl');
  makeForgeRelay(forgeRelayDir, forgeRelayLog);
  // `/forge` opens the hook's own gate (isForgeInvocation); `; touch … #` is
  // the shape that a bare `shell: true` spawn (the pre-fix code) executes as
  // a second shell command — under the fixed `shell: false` spawn it can
  // only ever be inert text inside one `--prompt` argv value.
  const injectionPrompt = `/forge do the thing; touch ${injectionMarker} #`;
  const hookEnv = {
    ...process.env,
    CLAUDE_PROJECT_DIR: dir,
    FORGEKIT_FLEET_DIR: path.join(SCRATCH, '.fleet'),
    PATH: `${forgeRelayDir}${path.delimiter}${process.env.PATH ?? ''}`,
  };
  delete hookEnv.CLAUDE_CODE_SESSION_ID;
  const hookRun = spawnSync(process.execPath, [promptHookPath], {
    input: JSON.stringify({ prompt: injectionPrompt }),
    encoding: 'utf8',
    cwd: dir,
    env: hookEnv,
  });
  if (hookRun.status !== 0) {
    fail(`forge-prompt-hook.mjs exited ${hookRun.status}`, `${hookRun.stdout}${hookRun.stderr}`);
  }
  if (fs.existsSync(injectionMarker)) {
    fail(
      'F79: the shipped prompt hook let a shell metacharacter in the prompt execute (command injection)',
      hookRun.stdout,
    );
  }
  // Not just "no crash": the relay logged the call it actually received,
  // proving the real forge spawn ran and carried the prompt byte-for-byte —
  // a hook that silently failed to reach `forge` at all would also leave the
  // marker absent, and would pass the check above for the wrong reason.
  if (!fs.existsSync(forgeRelayLog)) {
    fail('F79: the hook never reached the forge spawn at all — the marker check above proves nothing', hookRun.stdout);
  }
  const relayCalls = fs
    .readFileSync(forgeRelayLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).argv);
  const promptBearingCall = relayCalls.find((argv) => argv[0] === 'reminder');
  if (!promptBearingCall || !promptBearingCall.includes(injectionPrompt)) {
    fail('F79: the real forge spawn did not carry the exact injection prompt', JSON.stringify(relayCalls));
  }
  process.stdout.write('F79 HOOK INJECTION GREEN\n');

  const relFoo = 'packages/cli/src/foo.test.mjs';
  const relNew = 'packages/cli/src/new.test.mjs';
  const relBar = 'packages/cli/src/bar.test.mjs';
  const relBaz = 'packages/cli/src/baz.test.mjs';

  // 2. denies a guarded baseline test with no allowance, naming the matched
  //    rule and the forge test-allow escape.
  const denied = forge(dir, ['guard', 'check', '--file', relFoo, '--json']);
  if (denied.code !== 2) {
    fail(`guard check exited ${denied.code} on a guarded baseline test, expected 2 (deny)`, denied.out);
  }
  let deniedOut;
  try {
    deniedOut = JSON.parse(denied.stdout);
  } catch {
    fail('guard check --json printed no parseable JSON on a deny', denied.out);
  }
  if (deniedOut.decision !== 'deny') fail(`decision ${deniedOut.decision}, expected deny`, denied.stdout);
  if (deniedOut.rule !== '**/*.test.*') fail(`rule ${deniedOut.rule}, expected the matched glob`, denied.stdout);
  if (!deniedOut.message || !deniedOut.message.includes(deniedOut.rule)) {
    fail('deny message did not name the matched rule', denied.stdout);
  }
  if (!deniedOut.message.includes('forge test-allow')) {
    fail('deny message did not name the forge test-allow escape', denied.stdout);
  }

  // 3. a test file created during the session (untracked at baseCommit) is
  //    not guarded — the discriminating half of the same rule above.
  const notGuarded = forge(dir, ['guard', 'check', '--file', relNew, '--json']);
  if (notGuarded.code !== 0) {
    fail(`guard check exited ${notGuarded.code} on a session-created test file, expected 0 (allow)`, notGuarded.out);
  }
  const notGuardedOut = JSON.parse(notGuarded.stdout);
  if (notGuardedOut.decision !== 'allow' || notGuardedOut.reason !== 'not-guarded') {
    fail(
      `session-created test file graded ${notGuardedOut.decision}/${notGuardedOut.reason}, expected allow/not-guarded`,
      notGuarded.stdout,
    );
  }

  // 4. forge test-allow flips the SAME check from deny to allow, and the
  //    reason surfaces on the flipped check.
  const allowReason = 'e2e: assertion rewritten for this fixture';
  const allow = forge(dir, ['test-allow', relFoo, '--reason', allowReason]);
  if (allow.code !== 0) fail(`forge test-allow exited ${allow.code}`, allow.out);
  const recheck = forge(dir, ['guard', 'check', '--file', relFoo, '--json']);
  if (recheck.code !== 0) {
    fail(`guard check exited ${recheck.code} after an allowance was recorded, expected 0 (allow)`, recheck.out);
  }
  const recheckOut = JSON.parse(recheck.stdout);
  if (recheckOut.decision !== 'allow' || recheckOut.reason !== 'allowance') {
    fail(`allowed check graded ${recheckOut.decision}/${recheckOut.reason}, expected allow/allowance`, recheck.stdout);
  }
  if (recheckOut.allowanceReason !== allowReason) {
    fail('the allowance reason did not surface on the flipped check', recheck.stdout);
  }
  process.stdout.write('GUARD CHECK/ALLOW GREEN\n');

  // 4a. F90 — the classifier folds case on darwin/win32 only, and this
  // runner is Linux, so the platform decision cannot be observed by driving
  // `forge guard check` alone (`guard-cli.mjs` exposes no flag/env to force
  // it — checked; there is none). Instead drive the SHIPPED, exported
  // `classifyGuarded`/`makeGitLsTree` directly, from a spawned driver, with
  // an explicit `caseInsensitive` on each of the two calls: a case-variant
  // of the tracked baseline `foo.test.mjs` must be guarded when folding is
  // forced on, and NOT guarded under an exact-match comparison — both
  // directions, against the same real git repo and baseCommit used above.
  const relFooCaseVariant = relFoo.replace('/foo.test.mjs', '/Foo.TEST.mjs');
  const caseFoldDriver = path.join(dir, '.forge', 'f90-case-fold-driver.mjs');
  writeCaseFoldDriver(caseFoldDriver);
  const guardModulePath = path.join(REPO, 'packages', 'cli', 'src', 'guard.mjs');
  function runCaseFold(caseInsensitive) {
    const r = spawnSync(
      process.execPath,
      [caseFoldDriver, guardModulePath, dir, baseCommit, relFooCaseVariant, String(caseInsensitive)],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) fail(`F90: case-fold driver exited ${r.status}`, `${r.stdout}${r.stderr}`);
    try {
      return JSON.parse(r.stdout);
    } catch {
      fail('F90: case-fold driver printed no parseable JSON', `${r.stdout}${r.stderr}`);
    }
    return undefined;
  }
  const folded = runCaseFold(true);
  if (!folded.guarded) {
    fail(
      `F90: classifyGuarded/makeGitLsTree(caseInsensitive: true) did not guard ${relFooCaseVariant}, ` +
        `a case-variant of the tracked baseline test ${relFoo}`,
      JSON.stringify(folded),
    );
  }
  const exact = runCaseFold(false);
  if (exact.guarded) {
    fail(
      `F90: classifyGuarded/makeGitLsTree(caseInsensitive: false) guarded ${relFooCaseVariant}, which is not ` +
        'literally tracked — the fixture no longer discriminates folding from exact match',
      JSON.stringify(exact),
    );
  }
  process.stdout.write('F90 CASE-FOLD GUARD GREEN\n');

  // 4b. FINAL-REVIEW C1 — the guard's own control surface is not classified
  //     as unguarded by the very classifier it configures: `guard.testGlobs:
  //     []` must not silently disable the guard (bar is still tracked and
  //     unallowanced at this point), and `.forge/config.json` itself must be
  //     denied like any other guarded file.
  const configPath = path.join(dir, '.forge', 'config.json');
  const configBefore = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null;
  fs.writeFileSync(configPath, `${JSON.stringify({ guard: { testGlobs: [] } }, null, 2)}\n`, 'utf8');
  const stillDenied = forge(dir, ['guard', 'check', '--file', relBar, '--json']);
  if (stillDenied.code !== 2) {
    fail('C1: guard.testGlobs: [] disabled the guard — the baseline test must still be denied', stillDenied.out);
  }
  const configDenied = forge(dir, ['guard', 'check', '--file', '.forge/config.json', '--json']);
  if (configDenied.code !== 2) fail('C1: .forge/config.json itself was not denied during implement', configDenied.out);
  if (configBefore === null) fs.rmSync(configPath, { force: true });
  else fs.writeFileSync(configPath, configBefore, 'utf8');
  process.stdout.write('C1 GUARD CONTROL-SURFACE (config.json) GREEN\n');

  // 4c. FINAL-REVIEW C2 — session.json (the guard's trust anchor) and
  //     active.json (session resolution) are themselves denied.
  const sessionJsonDenied = forge(dir, ['guard', 'check', '--file', '.forge/sessions/s1/session.json', '--json']);
  if (sessionJsonDenied.code !== 2) fail('C2: session.json was not denied during implement', sessionJsonDenied.out);
  const activeJsonDenied = forge(dir, ['guard', 'check', '--file', '.forge/active.json', '--json']);
  if (activeJsonDenied.code !== 2) fail('C2: active.json was not denied during implement', activeJsonDenied.out);
  process.stdout.write('C2 GUARD CONTROL-SURFACE (session.json/active.json) GREEN\n');

  // 4d. FINAL-REVIEW C3 — a second, out-of-window session named by
  //     active.json must not shadow the in-window session (s1) that
  //     actually guards the file.
  fs.mkdirSync(path.join(dir, '.forge', 'sessions', 'decoy'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.forge', 'sessions', 'decoy', 'session.json'),
    `${JSON.stringify({ id: 'decoy', slug: 'decoy', phase: 'triage' })}\n`,
    'utf8',
  );
  const activeBefore = fs.readFileSync(path.join(dir, '.forge', 'active.json'), 'utf8');
  fs.writeFileSync(path.join(dir, '.forge', 'active.json'), `${JSON.stringify({ sessionId: 'decoy' })}\n`, 'utf8');
  const crossSessionDenied = forge(dir, ['guard', 'check', '--file', relBar, '--json']);
  if (crossSessionDenied.code !== 2) {
    fail(
      'C3: a decoy out-of-window session named by active.json shadowed the guarding session (s1)',
      crossSessionDenied.out,
    );
  }
  let crossSessionOut;
  try {
    crossSessionOut = JSON.parse(crossSessionDenied.stdout);
  } catch {
    fail('C3: guard check --json printed no parseable JSON on the cross-session deny', crossSessionDenied.out);
  }
  if (crossSessionOut.sessionId !== 's1') {
    fail(`C3: deny named session ${crossSessionOut.sessionId}, expected s1 (the actual guarding session)`, crossSessionDenied.stdout);
  }
  fs.writeFileSync(path.join(dir, '.forge', 'active.json'), activeBefore, 'utf8'); // restore for the steps below
  fs.rmSync(path.join(dir, '.forge', 'sessions', 'decoy'), { recursive: true, force: true }); // and the decoy itself —
  // gate-class commands below (forge test-allow) refuse on ANY ambiguity,
  // not just a misdirected pointer, so a leftover second session would break
  // them even with active.json restored.
  process.stdout.write('C3 CROSS-SESSION GUARD GREEN\n');

  // 5. THE BACKSTOP — on the CLI, not the hook, which is the half that must
  //    hold on a host with no hooks wired at all. A clean control FIRST:
  //    nothing has moved since the commit apart from the untracked
  //    new.test.mjs and foo's ledger entry above, so a clean
  //    `forge integrity-check` must already read ok:true with zero problems
  //    — proof that the RED step below is the guard finding, not some other
  //    problem this fixture happens to carry.
  const clean = forge(dir, ['integrity-check']);
  if (clean.code !== 0) fail('forge integrity-check refused a clean session before any tamper', clean.out);
  let cleanReport;
  try {
    cleanReport = JSON.parse(clean.stdout);
  } catch {
    fail('integrity-check printed no parseable JSON on the clean run', clean.out);
  }
  if (cleanReport.problems.length !== 0) {
    fail('THE CONTROL IS THE TEST: a clean session already carries integrity problems', JSON.stringify(cleanReport.problems));
  }

  // RED: modify one baseline test, delete another — neither has an allowance.
  fs.appendFileSync(barTest, 'tampered\n', 'utf8');
  fs.rmSync(bazTest);
  const tampered = forge(dir, ['integrity-check']);
  if (tampered.code === 0) {
    fail('forge integrity-check accepted a modified+deleted baseline test with no allowance', tampered.out);
  }
  const tamperedReport = JSON.parse(tampered.stdout);
  const namesBar = tamperedReport.problems.some((p) => p.includes(relBar) && p.includes('without allowance'));
  const namesBaz = tamperedReport.problems.some((p) => p.includes(relBaz) && p.includes('without allowance'));
  if (!namesBar) fail(`integrity-check did not name the modified file ${relBar}`, JSON.stringify(tamperedReport.problems, null, 2));
  if (!namesBaz) fail(`integrity-check did not name the deleted file ${relBaz}`, JSON.stringify(tamperedReport.problems, null, 2));

  // GREEN: allow both, WITHOUT reverting either tamper — the finding must
  // clear because of the allowance, not because the change went away.
  const allowBar = forge(dir, ['test-allow', relBar, '--reason', 'e2e: intentional tamper for the backstop step']);
  if (allowBar.code !== 0) fail(`forge test-allow exited ${allowBar.code} for ${relBar}`, allowBar.out);
  const allowBaz = forge(dir, ['test-allow', relBaz, '--reason', 'e2e: intentional delete for the backstop step']);
  if (allowBaz.code !== 0) fail(`forge test-allow exited ${allowBaz.code} for ${relBaz}`, allowBaz.out);

  const cleared = forge(dir, ['integrity-check']);
  if (cleared.code !== 0) fail('forge integrity-check still refused once both tampers were allowed', cleared.out);
  const clearedReport = JSON.parse(cleared.stdout);
  if (clearedReport.problems.length !== 0) {
    fail('allowances did not fully clear the guarded-files finding', JSON.stringify(clearedReport.problems, null, 2));
  }

  process.stdout.write('TEST GUARD GREEN\n');
} else if (phase === 'tdd-evidence') {
  const { dir, sessionDir } = makeTddEvidenceProject(TDD_EVIDENCE_PROJECT);
  const TASK = '01-guard';
  const GREEN_ONLY_TASK = '02-pass-only';
  const DOCS_TASK = '03-docs-only';
  const MISMATCH_TASK = '04-mismatched-pair';
  const failingCmd = [process.execPath, '-e', 'process.exit(1)'];
  const passingCmd = [process.execPath, '-e', 'process.exit(0)'];
  // TASK's genuine pair uses the SAME cmd+args for both runs — a real
  // red→green cycle re-runs one command and watches its outcome change, it
  // does not swap in an unrelated command for the green half. The outcome
  // flips because `flagFile` starts absent (red: exit 1) and is created
  // between the two `forge tdd run` calls below (green: exit 0), a genuine
  // state change, not a forged pairing (design D6, final-review I2).
  const flagFile = path.join(dir, 'tdd-evidence.flag');
  const pairedCmd = [
    process.execPath,
    '-e',
    "process.exit(require('fs').existsSync(process.argv[1]) ? 0 : 1)",
    flagFile,
  ];

  // 1. forge tdd run executes the command itself and stamps the outcome:
  //    the command under --expect fail (flag absent) exits non-zero and
  //    stamps ok:true; the SAME command under --expect pass (flag now
  //    present) exits zero and stamps the green.
  const red = forge(dir, ['tdd', 'run', '--task', TASK, '--expect', 'fail', '--', ...pairedCmd]);
  if (red.code !== 0) fail(`forge tdd run --expect fail exited ${red.code} for a genuinely failing command`, red.out);
  fs.writeFileSync(flagFile, '');
  const green = forge(dir, ['tdd', 'run', '--task', TASK, '--expect', 'pass', '--', ...pairedCmd]);
  if (green.code !== 0) fail(`forge tdd run --expect pass exited ${green.code} for a genuinely passing command`, green.out);

  const tddRunsFile = path.join(sessionDir, 'tasks', TASK, 'tdd-runs.jsonl');
  const readStamps = () =>
    fs
      .readFileSync(tddRunsFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  let stamps = readStamps();
  if (stamps.length !== 2) fail(`tdd-runs.jsonl has ${stamps.length} line(s), expected 2 after the red+green pair`, JSON.stringify(stamps));
  if (stamps[0].expect !== 'fail' || stamps[0].ok !== true || stamps[0].exit === 0) {
    fail('the red stamp is not expect:fail/ok:true with a non-zero exit', JSON.stringify(stamps[0]));
  }
  if (stamps[1].expect !== 'pass' || stamps[1].ok !== true || stamps[1].exit !== 0) {
    fail('the green stamp is not expect:pass/ok:true with a zero exit', JSON.stringify(stamps[1]));
  }
  if (stamps[0].cmd !== stamps[1].cmd || JSON.stringify(stamps[0].args) !== JSON.stringify(stamps[1].args)) {
    fail('TASK\'s red and green stamps do not share cmd+args — this fixture no longer proves a same-command pair', JSON.stringify(stamps, null, 2));
  }
  process.stdout.write('TDD RUN RED+GREEN STAMPED\n');

  // 2. A contradicted expectation (--expect fail against a passing command)
  //    exits non-zero and is still stamped, with ok:false.
  const contradicted = forge(dir, ['tdd', 'run', '--task', TASK, '--expect', 'fail', '--', ...passingCmd]);
  if (contradicted.code === 0) {
    fail('forge tdd run exited 0 for a contradicted expectation (expected fail, command passed)', contradicted.out);
  }
  stamps = readStamps();
  if (stamps.length !== 3) fail(`tdd-runs.jsonl has ${stamps.length} line(s), expected 3 after the contradiction`, JSON.stringify(stamps));
  if (stamps[2].expect !== 'fail' || stamps[2].ok !== false || stamps[2].exit !== 0) {
    fail('the contradicted stamp is not expect:fail/ok:false with a zero exit', JSON.stringify(stamps[2]));
  }
  process.stdout.write('TDD RUN CONTRADICTION STAMPED\n');

  // 3. THE PAIRING GATE. A sibling task holding only a pass-stamp (no red
  //    ever recorded) must make `forge integrity-check` refuse, naming it —
  //    while TASK, which has a genuine red-before-green pair (the
  //    contradiction above is ok:false and does not count as either), stays
  //    clear. One run proves both halves at once: the gate discriminates
  //    between the two task dirs, not merely "some task is unpaired".
  const greenOnly = forge(dir, ['tdd', 'run', '--task', GREEN_ONLY_TASK, '--expect', 'pass', '--', ...passingCmd]);
  if (greenOnly.code !== 0) fail(`forge tdd run exited ${greenOnly.code} recording the green-only sibling`, greenOnly.out);

  const gated = forge(dir, ['integrity-check']);
  if (gated.code === 0) {
    fail('forge integrity-check accepted a session with a green-without-red task', gated.out);
  }
  let gatedReport;
  try {
    gatedReport = JSON.parse(gated.stdout);
  } catch {
    fail('integrity-check printed no parseable JSON', gated.out);
  }
  const namesGreenOnly = gatedReport.problems.some((p) => p.includes(GREEN_ONLY_TASK));
  const namesTask = gatedReport.problems.some((p) => p.includes(TASK));
  if (!namesGreenOnly) fail(`integrity-check did not name the green-only task ${GREEN_ONLY_TASK}`, JSON.stringify(gatedReport.problems, null, 2));
  if (namesTask) {
    fail(`integrity-check flagged ${TASK}, which holds a valid red-before-green pair`, JSON.stringify(gatedReport.problems, null, 2));
  }
  process.stdout.write('TDD PAIRING GATE GREEN (discriminates paired vs unpaired)\n');

  // 4. THE --no-tdd EXEMPTION, proved at the point enforcement actually lives
  //    now: THE WRITE ITSELF, not a later `integrity-check` scan.
  //
  //    Before commit f4bf653 ("fix(tdd): align subagent executed evidence",
  //    2026-08-09), `forge evidence` (no --no-tdd) would happily record a
  //    task's evidence with no red→green ledger at all, and only
  //    `integrity-check` caught it later, on the next scan — a task dir left
  //    holding `test-evidence.md` with no `tdd-runs.jsonl` and no exemption
  //    marker. That is the shape this step used to build (record undeclared
  //    evidence, watch the LATER gate refuse it, re-record with --no-tdd,
  //    watch the gate clear).
  //
  //    `record-evidence.mjs` now refuses the write itself: in a
  //    `features.tddEvidence` session, plain `forge evidence` on a task with
  //    no `tdd-runs.jsonl` yet is rejected before anything touches disk (see
  //    its own design note: "plain forge evidence without --no-tdd is
  //    refused only while the task lacks a TDD ledger"). There is no
  //    supported command left that reaches the state this step used to
  //    build — a *completed* task carrying `test-evidence.md` with no ledger
  //    and no declaration — because the one writer of `test-evidence.md`
  //    refuses before that state can exist. This step now proves the
  //    refusal at its new home instead: the write, not a later scan.
  //
  //    The gate's OTHER route to the same class of problem — a task that IS
  //    complete (carries `tdd-runs.jsonl`) but whose stamps never pair a red
  //    before a green, and carries no declaration — is not obsolete, and
  //    step 3 above already proves it stays refused (GREEN_ONLY_TASK).
  const undeclared = forge(dir, [
    'evidence', '--task', DOCS_TASK, '--command', 'echo ok', '--exit', '0', '--summary', 'manual check',
  ]);
  if (undeclared.code === 0) {
    fail(
      'forge evidence recorded undeclared evidence for a tddEvidence-session task with no ledger — ' +
        "record-evidence.mjs's write-time refusal (f4bf653) is no longer enforced",
      undeclared.out,
    );
  }
  if (!undeclared.out.includes(DOCS_TASK)) {
    fail(
      `the refusal did not name the task ${DOCS_TASK} — a future silent-success regression would be ` +
        'invisible with only an exit code to go on',
      undeclared.out,
    );
  }
  const evidenceFile = path.join(sessionDir, 'tasks', DOCS_TASK, 'test-evidence.md');
  if (fs.existsSync(evidenceFile)) {
    fail(
      `forge evidence refused the write (exit ${undeclared.code}) but test-evidence.md exists for ${DOCS_TASK} ` +
        'anyway — a refusal that writes the file regardless is a different bug, and worth catching here',
      undeclared.out,
    );
  }
  process.stdout.write('TDD PLAIN EVIDENCE REFUSED AT WRITE TIME (named, wrote nothing)\n');

  // Now the exemption: --no-tdd --reason on the SAME task succeeds, writes
  // the exemption marker and the reason, and integrity-check clears it. This
  // half of the fixture is untouched by the enforcement-point move above.
  const reason = 'documentation only, no behavior change';
  const declare = forge(dir, ['evidence', '--task', DOCS_TASK, '--no-tdd', '--reason', reason]);
  if (declare.code !== 0) fail(`forge evidence --no-tdd exited ${declare.code}`, declare.out);
  const evidenceBody = fs.readFileSync(evidenceFile, 'utf8');
  if (!evidenceBody.includes(NO_TDD_MARKER)) {
    fail(`test-evidence.md for ${DOCS_TASK} does not carry the exemption marker`, evidenceBody);
  }
  if (!evidenceBody.includes(reason)) {
    fail('the recorded reason does not appear in the task evidence file', evidenceBody);
  }

  const afterDeclare = forge(dir, ['integrity-check']);
  const afterDeclareReport = JSON.parse(afterDeclare.stdout);
  const stillNamesDocs = afterDeclareReport.problems.some((p) => p.includes(DOCS_TASK));
  if (stillNamesDocs) {
    fail(`integrity-check still named ${DOCS_TASK} after its --no-tdd exemption was recorded`, JSON.stringify(afterDeclareReport.problems, null, 2));
  }
  // GREEN_ONLY_TASK is untouched by any of this and must still be the one
  // thing keeping the gate red — otherwise this run would prove nothing
  // about the exemption specifically.
  const stillNamesGreenOnly = afterDeclareReport.problems.some((p) => p.includes(GREEN_ONLY_TASK));
  if (!stillNamesGreenOnly) {
    fail('the green-only task stopped being named — this run no longer isolates the exemption', JSON.stringify(afterDeclareReport.problems, null, 2));
  }
  process.stdout.write('TDD NO-TDD EXEMPTION GREEN (write-time refusal, declared cleared)\n');

  // 5. Executed stamps count as tier-2 evidence for scoring: TASK's only
  //    evidence is a red→green tdd-runs.jsonl (no test-evidence.md at all),
  //    and it must still count toward coverage, same as GREEN_ONLY_TASK
  //    (stamped, if unpaired) and DOCS_TASK (test-evidence.md). All three
  //    task dirs should read as carrying tier-2 evidence.
  const scored = forge(dir, ['score', '--json']);
  if (scored.code !== 0 && scored.code !== 1) {
    // score-cli exits non-zero only in the strict --write path; --json alone
    // always prints a report, so anything else here is a real failure.
    fail(`forge score --json exited ${scored.code}`, scored.out);
  }
  let scorecard;
  try {
    scorecard = JSON.parse(scored.stdout);
  } catch {
    fail('forge score --json printed no parseable JSON', scored.out);
  }
  const tasksCheck = (scorecard.checks ?? []).find((c) => c?.id === 'tasks');
  if (!tasksCheck) fail('scorecard has no "tasks" check', JSON.stringify(scorecard, null, 2));
  const tasksNotes = (tasksCheck.notes ?? []).join(' | ');
  if (!tasksNotes.includes('tier-2 evidence in 3/3 task dirs')) {
    fail(
      `TASK's tdd-run-only evidence was not counted toward tier-2 coverage: ${tasksNotes}`,
      JSON.stringify(tasksCheck, null, 2),
    );
  }
  process.stdout.write('TDD SCORE GREEN (tdd-run-only task counted as tier-2)\n');

  // 6. THE PAIRING GATE CORRELATES BY COMMAND (final-review I2 regression):
  //    an ok fail-stamp for one command and an ok pass-stamp for a
  //    different, unrelated command must NOT satisfy the gate, even though
  //    both stamps are genuine and CLI-authored — reproduces the reviewer's
  //    `forge tdd run --expect fail -- false` then `--expect pass -- true`
  //    finding (here: two invocations of the same interpreter with
  //    different -e arguments, so this also proves args are compared, not
  //    just the executable name).
  const mismatchRed = forge(dir, ['tdd', 'run', '--task', MISMATCH_TASK, '--expect', 'fail', '--', ...failingCmd]);
  if (mismatchRed.code !== 0) {
    fail(`forge tdd run --expect fail exited ${mismatchRed.code} recording the mismatched-pair red`, mismatchRed.out);
  }
  const mismatchGreen = forge(dir, ['tdd', 'run', '--task', MISMATCH_TASK, '--expect', 'pass', '--', ...passingCmd]);
  if (mismatchGreen.code !== 0) {
    fail(`forge tdd run --expect pass exited ${mismatchGreen.code} recording the mismatched-pair green`, mismatchGreen.out);
  }
  const mismatchGate = forge(dir, ['integrity-check']);
  if (mismatchGate.code === 0) {
    fail(
      'forge integrity-check accepted a task with an ok fail-stamp for one command and an ok pass-stamp ' +
        'for a different, unrelated command (I2 regression: false-then-true must not clear the gate)',
      mismatchGate.out,
    );
  }
  let mismatchReport;
  try {
    mismatchReport = JSON.parse(mismatchGate.stdout);
  } catch {
    fail('integrity-check printed no parseable JSON for the mismatched-pair task', mismatchGate.out);
  }
  const namesMismatch = mismatchReport.problems.some((p) => p.includes(MISMATCH_TASK));
  if (!namesMismatch) {
    fail(`integrity-check did not name ${MISMATCH_TASK}`, JSON.stringify(mismatchReport.problems, null, 2));
  }
  process.stdout.write('TDD PAIRING GATE CORRELATES BY COMMAND (I2 regression closed)\n');

  process.stdout.write('TDD EVIDENCE GREEN\n');
} else {
  process.stderr.write(
    'Usage: harness-portability.mjs all|boot|record|show|red-run|quiet-cases|telemetry-collect|' +
      'telemetry-analyze|review-evidence-decides|review-evidence-substance|' +
      'review-evidence-survives|review-evidence-pruned-record|review-evidence-partial-binding|' +
      'review-stamp-decides|session-ambiguity|doctor-wiring|test-guard|tdd-evidence\n',
  );
  process.exit(1);
}
