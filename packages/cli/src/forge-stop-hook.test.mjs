/**
 * `templates/project/claude/hooks/forge-stop-hook.mjs` — the Claude Code
 * `Stop` hook that blocks turn-end only when the active Forge session claims
 * completion while `forge integrity-check` fails.
 * Per specs/changes/unlazy-enforcement/specs/stop-gate/spec.md.
 *
 * The fast path (loop-protection, session/config resolution, phase and
 * claim-state checks) is plain `node:fs` — no child process — and is
 * exercised here without any forge binary at all. Only claim-state drives a
 * spawn, which the tests observe via a fake `forge` command injected through
 * `FORGE_STOP_HOOK_FORGE_CMD` (fast, deterministic), plus one test against
 * the real `packages/cli/bin/forge.mjs integrity-check` to prove the wiring
 * end to end.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveTemplatesRoot } from './init.mjs';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SRC, '..', '..', '..');
const TEMPLATE_HOOK = path.join(resolveTemplatesRoot(), 'claude', 'hooks', 'forge-stop-hook.mjs');
const REAL_FORGE_BIN = path.join(REPO_ROOT, 'packages', 'cli', 'bin', 'forge.mjs');

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

/**
 * A scratch project: `.forge/active.json` pointing at a session, plus that
 * session's `session.json`. No git repo — `checkGuardedFiles` (inside
 * `forge integrity-check`) skips itself without a recorded `baseCommit`, so
 * the fixture stays plain fs, matching the hook's own fast path.
 */
function makeProject({
  phase = 'implement',
  tasksTotal,
  tasksComplete,
  stopGate,
  sessionId = 's1',
  rootPrefix = 'stop-hook-',
} = {}) {
  const root = tmp(rootPrefix);
  const sessionDir = path.join(root, '.forge', 'sessions', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const session = {
    id: sessionId,
    slug: 'fixture',
    phase,
    ...(tasksTotal === undefined ? {} : { tasksTotal }),
    ...(tasksComplete === undefined ? {} : { tasksComplete }),
  };
  fs.writeFileSync(path.join(sessionDir, 'session.json'), `${JSON.stringify(session)}\n`, 'utf8');
  fs.writeFileSync(
    path.join(root, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId })}\n`,
    'utf8',
  );
  if (stopGate !== undefined) {
    fs.writeFileSync(
      path.join(root, '.forge', 'config.json'),
      `${JSON.stringify({ hooks: { stopGate } })}\n`,
      'utf8',
    );
  }
  return { root, sessionDir, sessionId };
}

/**
 * @param {string} root cwd for the hook process (== CLAUDE_PROJECT_DIR)
 * @param {unknown} payload Stop-hook payload object, or a raw string when `raw` given
 * @param {{ raw?: string, env?: Record<string, string> }} [opts]
 */
function runHook(root, payload, opts = {}) {
  const input = opts.raw !== undefined ? opts.raw : JSON.stringify(payload);
  return spawnSync(process.execPath, [TEMPLATE_HOOK], {
    input,
    encoding: 'utf8',
    cwd: root,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...(opts.env ?? {}) },
  });
}

/**
 * A fake `forge` command the hook can be pointed at via
 * `FORGE_STOP_HOOK_FORGE_CMD`. Writes `sentinelFile` (if given) whenever it
 * is invoked at all — proof of whether the hook spawned anything — then, for
 * an `integrity-check` invocation, prints `{ ok, problems }` and exits with
 * `exitCode`.
 */
function writeFakeForge(dir, { exitCode = 0, problems = [], sentinelFile } = {}) {
  const file = path.join(dir, 'fake-forge.mjs');
  const body = `
import fs from 'node:fs';
const args = process.argv.slice(2);
${sentinelFile ? `fs.writeFileSync(${JSON.stringify(sentinelFile)}, 'spawned\\n');\n` : ''}
if (args[0] === 'integrity-check') {
  process.stdout.write(JSON.stringify({ ok: ${JSON.stringify(exitCode === 0)}, problems: ${JSON.stringify(problems)} }));
  process.exit(${exitCode});
}
process.exit(0);
`;
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function fakeForgeCmd(file) {
  return `"${process.execPath}" "${file}"`;
}

test('no active session: exit 0, empty stdout, no spawn', () => {
  const root = tmp('stop-hook-no-session-');
  const sentinel = path.join(root, 'SPAWNED');
  const fake = writeFakeForge(root, { sentinelFile: sentinel });
  const r = runHook(root, {}, { env: { FORGE_STOP_HOOK_FORGE_CMD: fakeForgeCmd(fake) } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(fs.existsSync(sentinel), false, 'no active session must never spawn');
});

test('mid-implement with open tasks: exit 0, empty stdout, integrity-check NOT spawned', () => {
  const { root } = makeProject({ phase: 'implement', tasksTotal: 3, tasksComplete: 1 });
  const sentinel = path.join(root, 'SPAWNED');
  const fake = writeFakeForge(root, { sentinelFile: sentinel });
  const r = runHook(root, {}, { env: { FORGE_STOP_HOOK_FORGE_CMD: fakeForgeCmd(fake) } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(fs.existsSync(sentinel), false, 'open tasks must never spawn a child process');
});

test('implement with tasksTotal 0 is never claim-state, even though 0 >= 0: no spawn', () => {
  // Guards against a `tasksComplete >= tasksTotal` check with no `tasksTotal >
  // 0` guard, which would treat an untracked (0/0) session as "done".
  const { root } = makeProject({ phase: 'implement', tasksTotal: 0, tasksComplete: 0 });
  const sentinel = path.join(root, 'SPAWNED');
  const fake = writeFakeForge(root, { sentinelFile: sentinel });
  const r = runHook(root, {}, { env: { FORGE_STOP_HOOK_FORGE_CMD: fakeForgeCmd(fake) } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(fs.existsSync(sentinel), false, 'tasksTotal=0 must not be treated as claim-state');
});

test('a session in brainstorm is never claim-state, even with tasksComplete >= tasksTotal: exit 0, no spawn', () => {
  const { root } = makeProject({ phase: 'brainstorm', tasksTotal: 5, tasksComplete: 5 });
  const sentinel = path.join(root, 'SPAWNED');
  const fake = writeFakeForge(root, { sentinelFile: sentinel });
  const r = runHook(root, {}, { env: { FORGE_STOP_HOOK_FORGE_CMD: fakeForgeCmd(fake) } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(fs.existsSync(sentinel), false);
});

test('claim-state (tasksComplete >= tasksTotal) with red integrity-check: blocks with the problem in the reason', () => {
  const { root } = makeProject({ phase: 'implement', tasksTotal: 3, tasksComplete: 3 });
  const problem = 'spine.json required at <fixture> — run forge spine init';
  const fake = writeFakeForge(root, { exitCode: 1, problems: [problem] });
  const r = runHook(root, {}, { env: { FORGE_STOP_HOOK_FORGE_CMD: fakeForgeCmd(fake) } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, new RegExp(problem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(out.reason, /forge integrity-check/);
  assert.match(out.reason, /forge defer list/);
  assert.match(out.reason, /forge e2e run/);
});

test('claim-state via phase (verify) with green integrity-check: exit 0, empty stdout', () => {
  const { root } = makeProject({ phase: 'verify' });
  const fake = writeFakeForge(root, { exitCode: 0, problems: [] });
  const r = runHook(root, {}, { env: { FORGE_STOP_HOOK_FORGE_CMD: fakeForgeCmd(fake) } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('stop_hook_active: true short-circuits before claim-state, even when red: exit 0, empty stdout, no spawn', () => {
  const { root } = makeProject({ phase: 'review' });
  const sentinel = path.join(root, 'SPAWNED');
  const fake = writeFakeForge(root, { exitCode: 1, problems: ['x'], sentinelFile: sentinel });
  const r = runHook(
    root,
    { stop_hook_active: true },
    { env: { FORGE_STOP_HOOK_FORGE_CMD: fakeForgeCmd(fake) } },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(fs.existsSync(sentinel), false, 'loop protection must fire before any spawn');
});

test('hooks.stopGate "off" short-circuits in the fast path, even when claim-state + red: exit 0, no spawn', () => {
  const { root } = makeProject({ phase: 'review', stopGate: 'off' });
  const sentinel = path.join(root, 'SPAWNED');
  const fake = writeFakeForge(root, { exitCode: 1, problems: ['x'], sentinelFile: sentinel });
  const r = runHook(root, {}, { env: { FORGE_STOP_HOOK_FORGE_CMD: fakeForgeCmd(fake) } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(fs.existsSync(sentinel), false, 'the off-switch must be checked before any spawn');
});

test('corrupt session.json: exit 0, empty stdout, no spawn', () => {
  const { root, sessionDir } = makeProject({ phase: 'review' });
  fs.writeFileSync(path.join(sessionDir, 'session.json'), '{ not json', 'utf8');
  const sentinel = path.join(root, 'SPAWNED');
  const fake = writeFakeForge(root, { sentinelFile: sentinel });
  const r = runHook(root, {}, { env: { FORGE_STOP_HOOK_FORGE_CMD: fakeForgeCmd(fake) } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(fs.existsSync(sentinel), false);
});

test('corrupt active.json: exit 0, empty stdout', () => {
  const root = tmp('stop-hook-corrupt-active-');
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(root, '.forge', 'active.json'), '{ not json', 'utf8');
  const r = runHook(root, {});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('active.json names a session with no session.json on disk: exit 0, empty stdout', () => {
  const root = tmp('stop-hook-missing-session-');
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId: 'ghost' })}\n`,
    'utf8',
  );
  const r = runHook(root, {});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('wired to the real forge integrity-check: red without spine.json, green once spine.json is a valid notApplicable doc', () => {
  const { root, sessionId, sessionDir } = makeProject({ phase: 'review' });
  const cmd = fakeForgeCmd(REAL_FORGE_BIN);

  // Fixture sanity: prove integrity-check is red on this fixture, and read
  // its actual first problem — the hook's reason is checked against this,
  // not against a string typed into the test.
  const direct = spawnSync(process.execPath, [REAL_FORGE_BIN, 'integrity-check', '--session', sessionId], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.notEqual(direct.status, 0, 'fixture sanity: no spine.json means integrity-check is red');
  const directOut = JSON.parse(direct.stdout);
  assert.ok(directOut.problems.length > 0, 'fixture sanity: red run reports at least one problem');

  const r = runHook(root, {}, { env: { FORGE_STOP_HOOK_FORGE_CMD: cmd } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.ok(
    out.reason.includes(directOut.problems[0]),
    'reason names the actual problem integrity-check reported',
  );

  // Now make the session green: a valid notApplicable spine.json.
  fs.writeFileSync(
    path.join(sessionDir, 'spine.json'),
    `${JSON.stringify({ rows: [], notApplicable: 'fixture — no capability wiring to prove' })}\n`,
    'utf8',
  );
  const directGreen = spawnSync(
    process.execPath,
    [REAL_FORGE_BIN, 'integrity-check', '--session', sessionId],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(directGreen.status, 0, 'fixture sanity: spine.json now makes integrity-check green');

  const r2 = runHook(root, {}, { env: { FORGE_STOP_HOOK_FORGE_CMD: cmd } });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(r2.stdout, '', 'green integrity-check exits 0 with no block JSON');
});
