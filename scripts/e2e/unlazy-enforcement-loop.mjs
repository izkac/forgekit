#!/usr/bin/env node
/**
 * Product loop for `specs/changes/unlazy-enforcement/e2e.json` — the
 * executable proof behind the three capability deltas in
 * `specs/changes/unlazy-enforcement/specs/` (stop-gate, task-gates,
 * e2e-harness). Pattern-matched on `scripts/e2e/harness-portability.mjs`:
 * scratch projects in a temp dir, driven through the SHIPPED CLI
 * (`packages/cli/bin/forge.mjs`) and the SHIPPED Stop-hook template, never a
 * reimplementation of either. Each subcommand asserts a domain side effect
 * (a file written, a JSON field, a file that must NOT exist) — never just an
 * exit code, so a stubbed handler fails every one of them.
 *
 * Subcommands (argv[2]), each printing one sentinel token on success and
 * exiting non-zero with a diagnostic on failure:
 *   stop-blocks      installed Stop hook blocks a claim-state turn while
 *                    forge integrity-check is red (missing spine.json)
 *   stop-allows      installed Stop hook fast-path allows a mid-implement
 *                    open-task turn without spawning `forge integrity-check`
 *                    at all (sentinel-file trick, not just an exit-code check)
 *   gates-loop       the full produce -> consume -> decision loop: red
 *                    integrity naming the ungated group -> forge gate check
 *                    writes green results -> integrity flips green
 *   gates-disabled   the opt-in wall: a project without gates.enabled
 *                    refuses `forge gate status` and writes nothing
 *   fingerprints     an executed e2e step's result carries outputSha256
 *                    (recomputed here from the fixture's own known output),
 *                    cwd, and shell
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FORGE_BIN = path.join(REPO, 'packages', 'cli', 'bin', 'forge.mjs');
const STOP_HOOK_TEMPLATE = path.join(
  REPO,
  'templates',
  'project',
  'claude',
  'hooks',
  'forge-stop-hook.mjs',
);

// Fixed path (kept apart per phase below), but keyed to this checkout so two
// clones can run the loop at the same time — same reasoning as
// harness-portability.mjs's own SCRATCH.
const SCRATCH_ROOT = path.join(
  os.tmpdir(),
  `forgekit-e2e-unlazy-${createHash('sha256').update(REPO).digest('hex').slice(0, 10)}`,
);

function fail(message, context) {
  process.stderr.write(`ASSERTION FAILED: ${message}\n${context ?? ''}\n`);
  process.exit(1);
}

/**
 * Run the real forge binary in `cwd`; never throws on a non-zero exit.
 *
 * `FORGEKIT_FLEET_DIR` is redirected into the scratch tree so session
 * bookkeeping never touches the operator's real `~/.forgekit/fleet` — same
 * convention as harness-portability.mjs's own `forge()` helper. The host's
 * own Claude Code session id is dropped for the same reason that helper
 * drops it: this drives a throwaway project, not the session running this
 * suite.
 */
function forge(cwd, args, extraEnv = {}) {
  const env = { ...process.env, FORGEKIT_FLEET_DIR: path.join(SCRATCH_ROOT, '.fleet'), ...extraEnv };
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync(process.execPath, [FORGE_BIN, ...args], { cwd, encoding: 'utf8', env });
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '', code: r.status };
}

/**
 * A throwaway project with an active session — the minimum shape the CLI
 * needs to resolve a session, mirroring harness-portability.mjs's own
 * `makeProject`. `openspecChange`/`tasks.md`/spine/gates are layered on top
 * by each phase that needs them; `stop-blocks`/`stop-allows` need nothing
 * beyond this.
 *
 * @param {string} dir
 * @param {{ tasksTotal: number, tasksComplete: number, phase?: string }} opts
 * @returns {{ dir: string, sessionDir: string }}
 */
function makeProject(dir, opts) {
  fs.rmSync(dir, { recursive: true, force: true });
  const sessionDir = path.join(dir, '.forge', 'sessions', 's1');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify({
      id: 's1',
      slug: 'unlazy-loop-fixture',
      phase: opts.phase ?? 'implement',
      tasksTotal: opts.tasksTotal,
      tasksComplete: opts.tasksComplete,
    })}\n`,
  );
  fs.writeFileSync(path.join(dir, '.forge', 'active.json'), `${JSON.stringify({ sessionId: 's1' })}\n`);
  return { dir, sessionDir };
}

/**
 * Install the SHIPPED Stop-hook template into a scratch project's
 * `.claude/hooks/` (the same file `forge init --claude` would have written)
 * and run it once against `dir`, feeding it `stdin` and pointing
 * `FORGE_STOP_HOOK_FORGE_CMD` at `forgeCmd` — proving the wiring is the real
 * shipped hook, not a reimplementation.
 *
 * @param {string} dir
 * @param {{ stdin: string, forgeCmd: string }} opts
 */
function runStopHook(dir, opts) {
  const hookPath = path.join(dir, '.claude', 'hooks', 'forge-stop-hook.mjs');
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.copyFileSync(STOP_HOOK_TEMPLATE, hookPath);
  const env = { ...process.env, FORGE_STOP_HOOK_FORGE_CMD: opts.forgeCmd };
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync(process.execPath, [hookPath], {
    cwd: dir,
    input: opts.stdin,
    encoding: 'utf8',
    env,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** `"<token>" "<token>"` — the space-quoted form `resolveForgeInvocation` in
 *  the shipped hook parses, so a spaced path (a real risk for `process.execPath`
 *  on Windows) still splits into exactly two tokens. */
function quotedInvocation(...tokens) {
  return tokens.map((t) => `"${t.replaceAll('"', '\\"')}"`).join(' ');
}

/* ================================================================== */
/* stop-blocks                                                         */
/* ================================================================== */

function stopBlocks() {
  const dir = `${SCRATCH_ROOT}-stop-blocks`;
  // Claim-state (tasksComplete >= tasksTotal) with no spine.json anywhere —
  // `forge integrity-check` is red for exactly one reason: the missing spine.
  makeProject(dir, { tasksTotal: 1, tasksComplete: 1 });

  const result = runStopHook(dir, {
    stdin: '{}',
    forgeCmd: quotedInvocation(process.execPath, FORGE_BIN),
  });

  if (result.code !== 0) {
    fail(`Stop hook must always exit 0 (fail-open); got ${result.code}`, result.stdout + result.stderr);
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch (err) {
    fail('Stop hook stdout did not parse as JSON', `${err}\nstdout: ${result.stdout}`);
  }
  if (payload.decision !== 'block') {
    fail(`expected decision "block", got ${JSON.stringify(payload.decision)}`, JSON.stringify(payload));
  }
  if (typeof payload.reason !== 'string' || !payload.reason.includes('integrity-check')) {
    fail('block reason must name forge integrity-check', JSON.stringify(payload));
  }
  process.stdout.write('STOP_BLOCKS_ON_RED\n');
}

/* ================================================================== */
/* stop-allows                                                         */
/* ================================================================== */

function stopAllows() {
  const dir = `${SCRATCH_ROOT}-stop-allows`;
  // Same shape as stop-blocks, but mid-implement with an open task —
  // claimState is false, so the fast path must return before ever spawning
  // `forge integrity-check`.
  makeProject(dir, { tasksTotal: 1, tasksComplete: 0 });

  // Sentinel-file trick: point FORGE_STOP_HOOK_FORGE_CMD at a "forge" that
  // would create a marker file if it were ever spawned. If the fast path
  // truly returns before spawning anything, the marker never exists —
  // proving the claim by domain side effect, not merely by exit code (a
  // fast-path bug that spawned a no-op child would still exit 0 with no
  // stdout, and only the marker's absence tells the two apart).
  const marker = path.join(dir, 'spawned.marker');
  const spy = path.join(dir, 'spy-forge.cjs');
  fs.writeFileSync(
    spy,
    `require('fs').writeFileSync(${JSON.stringify(marker)}, 'spawned');\nprocess.exit(1);\n`,
  );

  const result = runStopHook(dir, {
    stdin: '{}',
    forgeCmd: quotedInvocation(process.execPath, spy),
  });

  if (result.code !== 0) {
    fail(`fast-path Stop hook must exit 0; got ${result.code}`, result.stdout + result.stderr);
  }
  if (result.stdout.trim() !== '') {
    fail('fast-path Stop hook must print nothing on stdout', JSON.stringify(result.stdout));
  }
  if (fs.existsSync(marker)) {
    fail(
      'marker file exists — the fast path spawned forge integrity-check on a mid-implement open-task turn',
      marker,
    );
  }
  process.stdout.write('STOP_ALLOWS_FAST_PATH\n');
}

/* ================================================================== */
/* gates-loop                                                          */
/* ================================================================== */

/** Exactly what the gate check's fixture script prints — the single source
 *  both the fixture and the `expect` regex below are built from. */
const GATE_CHECK_OUTPUT = 'GATE_OK';

function gatesLoop() {
  const dir = `${SCRATCH_ROOT}-gates-loop`;
  // makeProject() rmSync's `dir` first — config.json must be written AFTER it,
  // or the wipe removes it again.
  const { sessionDir } = makeProject(dir, { tasksTotal: 1, tasksComplete: 1 });

  fs.writeFileSync(
    path.join(dir, '.forge', 'config.json'),
    `${JSON.stringify({ plan: { engine: 'specs', dir: 'specs' }, gates: { enabled: true } }, null, 2)}\n`,
  );
  // makeProject already wrote session.json/active.json; layer the change
  // name + planType onto session.json (makeProject's shape is the shared
  // stop-hook fixture, which has neither).
  const sessionFile = path.join(sessionDir, 'session.json');
  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  session.planType = 'specs';
  session.openspecChange = 'my-change';
  fs.writeFileSync(sessionFile, `${JSON.stringify(session, null, 2)}\n`);

  const changeDir = path.join(dir, 'specs', 'changes', 'my-change');
  fs.mkdirSync(changeDir, { recursive: true });
  fs.writeFileSync(path.join(changeDir, 'tasks.md'), '## 1. Group one\n\n- [x] 1.1 wire it\n');
  // notApplicable spine: valid on its own, so the ONLY thing left red is the
  // task gate — the loop this phase exists to prove, isolated from the
  // separate e2e-gate machinery.
  fs.writeFileSync(
    path.join(changeDir, 'spine.json'),
    `${JSON.stringify({ notApplicable: 'gates-loop e2e fixture — no runtime spine', rows: [] }, null, 2)}\n`,
  );

  const checkScript = path.join(dir, 'gate-check-probe.mjs');
  fs.writeFileSync(checkScript, `console.log(${JSON.stringify(GATE_CHECK_OUTPUT)});\n`);
  fs.writeFileSync(
    path.join(changeDir, 'gates.json'),
    `${JSON.stringify(
      {
        groups: [
          {
            id: '1',
            title: 'Group one',
            check: `node ${JSON.stringify(checkScript.replaceAll('\\', '/'))}`,
            expect: GATE_CHECK_OUTPUT,
            timeoutMs: 60000,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  // 1. Red integrity, naming the ungated group — before any gate has run.
  const before = forge(dir, ['integrity-check', '--session', 's1']);
  if (before.code === 0) fail('forge integrity-check should be red before any gate check has run', before.out);
  let beforeOut;
  try {
    beforeOut = JSON.parse(before.stdout);
  } catch (err) {
    fail('forge integrity-check --session s1 printed no parseable JSON', `${err}\n${before.out}`);
  }
  if (!(beforeOut.problems ?? []).some((p) => p.includes('gate group 1'))) {
    fail('integrity-check problems must name gate group 1', JSON.stringify(beforeOut.problems));
  }

  // 2. Produce: run the gate check — writes gate-results.json.
  const gateRun = forge(dir, ['gate', 'check', '--group', '1', '--session', 's1']);
  if (gateRun.code !== 0) fail('forge gate check --group 1 should exit 0 on a passing check', gateRun.out);
  const resultsFile = path.join(sessionDir, 'gate-results.json');
  if (!fs.existsSync(resultsFile)) fail('forge gate check did not write gate-results.json', resultsFile);
  const results = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  const entry = (results.groups ?? []).find((g) => g.id === '1');
  if (!entry || entry.ok !== true) {
    fail('gate-results.json must record group 1 as ok:true', JSON.stringify(results));
  }

  // 3. Consume + decision: integrity now reads the fresh gate-results.json
  // and flips green.
  const after = forge(dir, ['integrity-check', '--session', 's1']);
  if (after.code !== 0) fail('forge integrity-check should be green once the gate is green', after.out);

  process.stdout.write('GATES_GREEN_INTEGRITY_OK\n');
}

/* ================================================================== */
/* gates-disabled                                                       */
/* ================================================================== */

/** Every relative path under `dir`, sorted — a before/after diff proves
 *  "writes nothing", not just "exits non-zero". */
function listTree(dir) {
  if (!fs.existsSync(dir)) return [];
  /** @type {string[]} */
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

function gatesDisabled() {
  const dir = `${SCRATCH_ROOT}-gates-disabled`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // Deliberately no .forge/config.json at all — the opt-in wall's default
  // state, and the shape most projects that have never touched gates are in.
  const before = listTree(dir);

  const result = forge(dir, ['gate', 'status']);
  if (result.code !== 1) fail(`forge gate status must exit 1 when gates are not enabled; got ${result.code}`, result.out);
  if (!result.out.includes('gates are not enabled')) {
    fail('forge gate status must print the one-line "not enabled" wall message', result.out);
  }
  const after = listTree(dir);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    fail('forge gate status must write nothing when gates are disabled', `before: ${before}\nafter: ${after}`);
  }
  process.stdout.write('GATES_DISABLED_WALL\n');
}

/* ================================================================== */
/* fingerprints                                                        */
/* ================================================================== */

/** Exactly what the fixture step's probe script writes to stdout — the
 *  single source both the fixture and the expected digest are computed
 *  from, never a hand-typed hex string. */
const FP_STEP_OUTPUT = 'FP_OK\n';

/** Mirrors `effectiveShell()` in packages/cli/src/integrity.mjs exactly
 *  (not imported — that function is unexported), so a drift between the two
 *  fails this assertion rather than silently agreeing with a broken shell
 *  resolution. */
function expectedShell() {
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe';
  return '/bin/sh';
}

function fingerprints() {
  const dir = `${SCRATCH_ROOT}-fingerprints`;
  const { sessionDir } = makeProject(dir, { tasksTotal: 1, tasksComplete: 1 });

  const probeScript = path.join(dir, 'fp-probe.mjs');
  fs.writeFileSync(probeScript, `process.stdout.write(${JSON.stringify(FP_STEP_OUTPUT)});\n`);
  // No openspecChange on this session, so e2ePath falls back to the session
  // dir — the minimal shape `forge e2e run` needs.
  fs.writeFileSync(
    path.join(sessionDir, 'e2e.json'),
    `${JSON.stringify(
      {
        steps: [{ name: 'fingerprint-probe', cmd: `node ${JSON.stringify(probeScript.replaceAll('\\', '/'))}` }],
      },
      null,
      2,
    )}\n`,
  );

  const run = forge(dir, ['e2e', 'run', '--session', 's1']);
  if (run.code !== 0) fail('forge e2e run should be green against the fixture probe', run.out);

  const resultsFile = path.join(sessionDir, 'e2e-results.json');
  if (!fs.existsSync(resultsFile)) fail('forge e2e run did not write e2e-results.json', resultsFile);
  const results = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  const step = (results.steps ?? [])[0];
  if (!step) fail('e2e-results.json has no steps', JSON.stringify(results));

  const expectedHash = createHash('sha256').update(FP_STEP_OUTPUT).digest('hex');
  if (step.outputSha256 !== expectedHash) {
    fail(
      `outputSha256 mismatch: expected ${expectedHash} (sha256 of the fixture's own known output), got ${step.outputSha256}`,
      JSON.stringify(step),
    );
  }
  if (path.resolve(step.cwd ?? '') !== path.resolve(dir)) {
    fail(`cwd mismatch: expected ${path.resolve(dir)}, got ${step.cwd}`, JSON.stringify(step));
  }
  const wantShell = expectedShell();
  if (step.shell !== wantShell) {
    fail(`shell mismatch: expected ${wantShell}, got ${step.shell}`, JSON.stringify(step));
  }
  process.stdout.write('FINGERPRINT_PRESENT\n');
}

/* ================================================================== */

const PHASES = {
  'stop-blocks': stopBlocks,
  'stop-allows': stopAllows,
  'gates-loop': gatesLoop,
  'gates-disabled': gatesDisabled,
  fingerprints,
};

const phase = process.argv[2];
const run = PHASES[phase];
if (!run) {
  process.stderr.write(
    `Usage: node ${path.basename(fileURLToPath(import.meta.url))} <${Object.keys(PHASES).join('|')}>\n`,
  );
  process.exit(1);
}
run();
