import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const TDD_RUN_CLI = path.join(SRC, 'tdd-run.mjs');
const BIN = path.join(SRC, '..', 'bin', 'forge.mjs');

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A scratch project: a git repo with a Forge session under `.forge/` in a
 * non-terminal phase, and `.forge/active.json` pointing at it. Mirrors
 * `guard-cli.test.mjs` / `test-allow-cli.test.mjs`'s `makeProject`. This
 * command does not consult guard classification, so no baseCommit/testGlobs
 * knobs are needed.
 */
function makeProject({ phase = 'implement', sessionId = 's1' } = {}) {
  const root = tmp('tdd-run-cli-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, 'README.md'), 'x\n', 'utf8');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');

  const sessionDir = path.join(root, '.forge', 'sessions', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const session = { id: sessionId, slug: 'fixture', phase };
  fs.writeFileSync(path.join(sessionDir, 'session.json'), `${JSON.stringify(session)}\n`, 'utf8');
  fs.writeFileSync(path.join(root, '.forge', 'active.json'), `${JSON.stringify({ sessionId })}\n`, 'utf8');
  return { root, sessionDir, sessionId };
}

/** A repo with `.forge/` present (so findRepoRoot lands here) but no sessions at all. */
function makeNoSessionProject() {
  const root = tmp('tdd-run-cli-nosession-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, 'README.md'), 'x\n', 'utf8');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  return root;
}

function runTddRun(cwd, args) {
  return spawnSync(process.execPath, [TDD_RUN_CLI, ...args], { cwd, encoding: 'utf8' });
}

function stampsPath(sessionDir, task) {
  return path.join(sessionDir, 'tasks', task, 'tdd-runs.jsonl');
}

function readStamps(sessionDir, task) {
  const file = stampsPath(sessionDir, task);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

/** Snapshot of every path under `.forge`, for "nothing written" assertions. */
function forgeTreeSnapshot(root) {
  return fs.readdirSync(path.join(root, '.forge'), { recursive: true }).sort();
}

const PASS = [process.execPath, '-e', 'process.exit(0)'];
const FAIL = [process.execPath, '-e', 'process.exit(1)'];

test('red stamp: a failing command with --expect fail exits 0 and stamps ok:true with the non-zero exit', () => {
  const { root, sessionDir } = makeProject();
  const r = runTddRun(root, ['run', '--task', '01-thing', '--expect', 'fail', '--', ...FAIL]);
  assert.equal(r.status, 0, r.stderr);
  const stamps = readStamps(sessionDir, '01-thing');
  assert.equal(stamps.length, 1);
  assert.equal(stamps[0].ok, true);
  assert.equal(stamps[0].expect, 'fail');
  assert.equal(stamps[0].exit, 1);
  assert.match(r.stderr, /tdd-runs\.jsonl.*expected=fail.*childExit=1.*ok=true/);
});

test('green stamp: a passing command with --expect pass exits 0 and stamps ok:true with exit 0', () => {
  const { root, sessionDir } = makeProject();
  const r = runTddRun(root, ['run', '--task', '01-thing', '--expect', 'pass', '--', ...PASS]);
  assert.equal(r.status, 0, r.stderr);
  const stamps = readStamps(sessionDir, '01-thing');
  assert.equal(stamps.length, 1);
  assert.equal(stamps[0].ok, true);
  assert.equal(stamps[0].expect, 'pass');
  assert.equal(stamps[0].exit, 0);
  assert.match(r.stderr, /tdd-runs\.jsonl.*expected=pass.*childExit=0.*ok=true/);
});

test('contradiction (pass expected fail): a passing command with --expect fail exits non-zero and stamps ok:false', () => {
  const { root, sessionDir } = makeProject();
  const r = runTddRun(root, ['run', '--task', '01-thing', '--expect', 'fail', '--', ...PASS]);
  assert.notEqual(r.status, 0);
  const stamps = readStamps(sessionDir, '01-thing');
  assert.equal(stamps.length, 1, 'a contradicted expectation is still stamped');
  assert.equal(stamps[0].ok, false);
  assert.equal(stamps[0].exit, 0);
  assert.match(r.stderr, /expected=fail.*childExit=0.*ok=false/);
});

test('contradiction (fail expected pass): a failing command with --expect pass exits non-zero and stamps ok:false', () => {
  const { root, sessionDir } = makeProject();
  const r = runTddRun(root, ['run', '--task', '01-thing', '--expect', 'pass', '--', ...FAIL]);
  assert.notEqual(r.status, 0);
  const stamps = readStamps(sessionDir, '01-thing');
  assert.equal(stamps.length, 1, 'a contradicted expectation is still stamped');
  assert.equal(stamps[0].ok, false);
  assert.equal(stamps[0].exit, 1);
  assert.match(r.stderr, /expected=pass.*childExit=1.*ok=false/);
});

test('signal-terminated command never becomes a usable expected RED stamp', { skip: process.platform === 'win32' }, () => {
  const { root, sessionDir } = makeProject();
  const r = runTddRun(root, [
    'run', '--task', '01-signal', '--expect', 'fail', '--',
    process.execPath, '-e', "process.kill(process.pid, 'SIGTERM')",
  ]);
  assert.notEqual(r.status, 0);
  const [stamp] = readStamps(sessionDir, '01-signal');
  assert.equal(stamp.exit, null);
  assert.equal(stamp.ok, false);
  assert.match(r.stderr, /expected=fail.*childExit=null.*ok=false/);
  assert.match(r.stderr, /SIGTERM/);
});

test('stamp schema: all seven fields present, startedAt parses as a date, durationMs is a non-negative number', () => {
  const { root, sessionDir } = makeProject();
  const r = runTddRun(root, ['run', '--task', '01-thing', '--expect', 'pass', '--', ...PASS]);
  assert.equal(r.status, 0, r.stderr);
  const [stamp] = readStamps(sessionDir, '01-thing');
  assert.deepEqual(
    Object.keys(stamp).sort(),
    ['args', 'cmd', 'durationMs', 'exit', 'expect', 'ok', 'startedAt'].sort(),
  );
  assert.equal(stamp.cmd, process.execPath);
  assert.deepEqual(stamp.args, ['-e', 'process.exit(0)']);
  assert.equal(Number.isNaN(Date.parse(stamp.startedAt)), false, 'startedAt must parse as a date');
  assert.equal(typeof stamp.durationMs, 'number');
  assert.ok(stamp.durationMs >= 0, 'durationMs must be non-negative');
});

test('timestamps are CLI-generated: a value the caller tries to smuggle in as a command arg cannot leak into the stamp', () => {
  const { root, sessionDir } = makeProject();
  const bogus = '1999-01-01T00:00:00.000Z';
  const before = Date.now();
  const r = runTddRun(root, [
    'run',
    '--task',
    '01-thing',
    '--expect',
    'pass',
    '--',
    process.execPath,
    '-e',
    'process.exit(0)',
    '--',
    '--started-at',
    bogus,
  ]);
  const after = Date.now();
  assert.equal(r.status, 0, r.stderr);
  const [stamp] = readStamps(sessionDir, '01-thing');
  assert.notEqual(stamp.startedAt, bogus);
  const startedMs = Date.parse(stamp.startedAt);
  assert.ok(
    startedMs >= before && startedMs <= after,
    `startedAt (${stamp.startedAt}) should be within the call window [${before}, ${after}]`,
  );
});

test('task directory is created when missing', () => {
  const { root, sessionDir } = makeProject();
  assert.equal(fs.existsSync(path.join(sessionDir, 'tasks')), false);
  const r = runTddRun(root, ['run', '--task', 'brand-new-task', '--expect', 'pass', '--', ...PASS]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(stampsPath(sessionDir, 'brand-new-task')), true);
});

test('appending: two runs against the same task produce two lines, in order', () => {
  const { root, sessionDir } = makeProject();
  const first = runTddRun(root, ['run', '--task', '01-thing', '--expect', 'fail', '--', ...FAIL]);
  assert.equal(first.status, 0, first.stderr);
  const second = runTddRun(root, ['run', '--task', '01-thing', '--expect', 'pass', '--', ...PASS]);
  assert.equal(second.status, 0, second.stderr);

  const stamps = readStamps(sessionDir, '01-thing');
  assert.equal(stamps.length, 2);
  assert.equal(stamps[0].expect, 'fail');
  assert.equal(stamps[0].exit, 1);
  assert.equal(stamps[1].expect, 'pass');
  assert.equal(stamps[1].exit, 0);
});

test('missing --task refuses: exit non-zero, nothing written under .forge', () => {
  const { root } = makeProject();
  const before = forgeTreeSnapshot(root);
  const r = runTddRun(root, ['run', '--expect', 'pass', '--', ...PASS]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--task/);
  assert.deepEqual(forgeTreeSnapshot(root), before);
});

test('missing --expect refuses: exit non-zero, nothing written under .forge', () => {
  const { root } = makeProject();
  const before = forgeTreeSnapshot(root);
  const r = runTddRun(root, ['run', '--task', '01-thing', '--', ...PASS]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--expect/);
  assert.deepEqual(forgeTreeSnapshot(root), before);
});

test('invalid --expect value refuses: exit non-zero, nothing written under .forge', () => {
  const { root } = makeProject();
  const before = forgeTreeSnapshot(root);
  const r = runTddRun(root, ['run', '--task', '01-thing', '--expect', 'maybe', '--', ...PASS]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--expect/);
  assert.deepEqual(forgeTreeSnapshot(root), before);
});

test('no command given refuses cleanly: exit non-zero, clear message, no stack trace, nothing written under .forge', () => {
  const { root } = makeProject();
  const before = forgeTreeSnapshot(root);
  const r = runTddRun(root, ['run', '--task', '01-thing', '--expect', 'pass']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no command given/i);
  // A raw crash (e.g. spawn(undefined) throwing uncaught) would also exit
  // non-zero without writing anything — this pins that the refusal is a
  // deliberate, clean usage error, not an uncaught exception.
  assert.doesNotMatch(r.stderr, /\n\s*at /, 'must not leak a stack trace');
  assert.deepEqual(forgeTreeSnapshot(root), before);
});

test('no open session at all refuses: exit non-zero, nothing written under .forge', () => {
  const root = makeNoSessionProject();
  const before = forgeTreeSnapshot(root);
  const r = runTddRun(root, ['run', '--task', '01-thing', '--expect', 'pass', '--', ...PASS]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /No active session/i);
  assert.deepEqual(forgeTreeSnapshot(root), before);
});

test('-- separator: flags belonging to the child (e.g. one spelled like our own --session) are passed through, not eaten', () => {
  const { root, sessionDir } = makeProject();
  // Without honoring `--`, a naive parser scanning for `--session` anywhere in
  // argv would swallow this literal token (and its "value") meant for the
  // child, and the child would never see it.
  const r = runTddRun(root, [
    'run',
    '--task',
    '01-thing',
    '--expect',
    'pass',
    '--',
    process.execPath,
    '-e',
    'process.exit(process.argv[1] === "--session" && process.argv[2] === "child-value" ? 0 : 1)',
    '--',
    '--session',
    'child-value',
  ]);
  assert.equal(r.status, 0, r.stderr);
  const [stamp] = readStamps(sessionDir, '01-thing');
  assert.equal(stamp.ok, true);
  assert.deepEqual(stamp.args, [
    '-e',
    'process.exit(process.argv[1] === "--session" && process.argv[2] === "child-value" ? 0 : 1)',
    '--',
    '--session',
    'child-value',
  ]);
});

test('spawn failure (e.g. ENOENT): stamps exit:null, ok:false, and exits non-zero with a clear message', () => {
  const { root, sessionDir } = makeProject();
  const missingBin = path.join(root, 'definitely-does-not-exist-xyz');
  const r = runTddRun(root, ['run', '--task', '01-thing', '--expect', 'pass', '--', missingBin, 'arg1']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /definitely-does-not-exist-xyz/);
  const [stamp] = readStamps(sessionDir, '01-thing');
  assert.equal(stamp.exit, null);
  assert.equal(stamp.ok, false);
  assert.equal(stamp.cmd, missingBin);
  assert.deepEqual(stamp.args, ['arg1']);
});

test('--session disambiguates: two open sessions, explicit --session s2 stamps into s2, not s1', () => {
  const root = tmp('tdd-run-cli-two-sessions-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, 'README.md'), 'x\n', 'utf8');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const sessionDirs = {};
  for (const id of ['s1', 's2']) {
    const dir = path.join(root, '.forge', 'sessions', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'session.json'),
      `${JSON.stringify({ id, slug: id, phase: 'implement' })}\n`,
      'utf8',
    );
    sessionDirs[id] = dir;
  }
  fs.writeFileSync(path.join(root, '.forge', 'active.json'), `${JSON.stringify({ sessionId: 's1' })}\n`, 'utf8');

  const r = runTddRun(root, ['run', '--task', '01-thing', '--expect', 'pass', '--session', 's2', '--', ...PASS]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(stampsPath(sessionDirs.s1, '01-thing')), false);
  assert.equal(readStamps(sessionDirs.s2, '01-thing').length, 1);
});

test('the command is registered under `forge tdd`: an end-to-end run through the bin wrapper stamps evidence', () => {
  const { root, sessionDir } = makeProject();
  const r = spawnSync(
    process.execPath,
    [BIN, 'tdd', 'run', '--task', '01-thing', '--expect', 'pass', '--', ...PASS],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readStamps(sessionDir, '01-thing').length, 1);
  assert.match(
    fs.readFileSync(BIN, 'utf8'),
    /^ {2}tdd: /m,
    'a registered command missing from COMMANDS would make this unreachable',
  );
});

test(
  'no `--`: the first token that is not one of our own flags starts the command, and everything ' +
    'after it (including a token spelled like --session) is passed through verbatim',
  () => {
    const { root, sessionDir } = makeProject();
    // No explicit `--` at all: `--task`/`--expect` are consumed, then the
    // executable is an unrecognized token and must stop the scan right there
    // — a parser that instead kept scanning past it for our own flags would
    // strip `--session zzz` out of the child's argv and treat `zzz` as a
    // session id, even though there is no `--` telling it to.
    const r = runTddRun(root, [
      'run',
      '--task',
      '01-t',
      '--expect',
      'fail',
      process.execPath,
      '-e',
      'process.exit(1)',
      '--session',
      'zzz',
    ]);
    assert.equal(r.status, 0, r.stderr);
    const stamps = readStamps(sessionDir, '01-t');
    assert.equal(stamps.length, 1, 'the run must be stamped under the real session, with a real command');
    const [stamp] = stamps;
    assert.equal(stamp.cmd, process.execPath);
    assert.deepEqual(stamp.args, ['-e', 'process.exit(1)', '--session', 'zzz']);
    assert.notEqual(stamp.exit, 0, "node rejects the unconsumed trailing flags, so the child's own exit is non-zero");
    assert.equal(stamp.ok, stamp.exit !== 0, 'ok must follow from the actual exit, not a hardcoded expectation');
    assert.equal(
      fs.existsSync(path.join(root, '.forge', 'sessions', 'zzz')),
      false,
      '"--session zzz" must never have been read as our own --session flag',
    );
  },
);

test('`forge tdd run --help` prints usage and exits 0, before the required-arg checks', () => {
  const { root } = makeProject();
  const before = forgeTreeSnapshot(root);
  const r = runTddRun(root, ['run', '--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /Usage: forge tdd run/);
  assert.doesNotMatch(r.stderr, /--task is required/);
  assert.deepEqual(forgeTreeSnapshot(root), before);
});

test('`forge tdd run -h` also prints usage and exits 0', () => {
  const { root } = makeProject();
  const r = runTddRun(root, ['run', '-h']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /Usage: forge tdd run/);
});
