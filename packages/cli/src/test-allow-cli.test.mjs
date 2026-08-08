import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const TEST_ALLOW_CLI = path.join(SRC, 'test-allow-cli.mjs');

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A scratch project: a git repo with one committed baseline test file, a
 * Forge session under `.forge/` carrying the given `phase`, and
 * `.forge/active.json` pointing at it. Mirrors `guard-cli.test.mjs`'s
 * `makeProject`.
 */
function makeProject({ phase = 'implement', sessionId = 's1' } = {}) {
  const root = tmp('test-allow-cli-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  fs.mkdirSync(path.join(root, 'packages', 'cli', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages', 'cli', 'src', 'foo.test.mjs'), 'baseline\n', 'utf8');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const baseCommit = git(root, 'rev-parse', 'HEAD');

  const sessionDir = path.join(root, '.forge', 'sessions', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const session = { id: sessionId, slug: 'fixture', phase, baseCommit };
  fs.writeFileSync(path.join(sessionDir, 'session.json'), `${JSON.stringify(session)}\n`, 'utf8');
  fs.writeFileSync(path.join(root, '.forge', 'active.json'), `${JSON.stringify({ sessionId })}\n`, 'utf8');
  return { root, sessionDir, sessionId, baseCommit };
}

/**
 * Two open sessions with `.forge/active.json` pointing at one of them
 * (`s1`). This is the case that actually discriminates gate-class (`strict:
 * true`) refusal from the ordinary warn-and-proceed behavior: with
 * `active.json` naming neither candidate, `resolveSessionId` already
 * returns `id: null` and *any* caller refuses regardless of `strict` — that
 * fixture cannot tell a strict resolver from a non-strict one. Here
 * `resolveSessionId` resolves an id (`s1`, `ambiguous: true`), so a
 * non-strict caller would warn and proceed on it; only a gate-class
 * (`strict: true`) caller refuses outright.
 */
function makeAmbiguousProject() {
  const root = tmp('test-allow-cli-ambiguous-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, 'a.test.mjs'), 'x\n', 'utf8');
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
  fs.writeFileSync(
    path.join(root, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId: 's1' })}\n`,
    'utf8',
  );
  return { root, sessionDirs };
}

function ledgerPath(sessionDir) {
  return path.join(sessionDir, 'guard-allowances.json');
}

function runTestAllow(cwd, args) {
  return spawnSync(process.execPath, [TEST_ALLOW_CLI, ...args], { cwd, encoding: 'utf8' });
}

test('happy path: records an entry with the session phase and a CLI-generated `at`', () => {
  const { root, sessionDir } = makeProject({ phase: 'implement' });
  const before = Date.now();
  const r = runTestAllow(root, ['packages/cli/src/foo.test.mjs', '--reason', 'assertion outdated by REQ-4']);
  const after = Date.now();
  assert.equal(r.status, 0, r.stderr);

  const ledger = JSON.parse(fs.readFileSync(ledgerPath(sessionDir), 'utf8'));
  assert.equal(ledger.length, 1);
  const [entry] = ledger;
  assert.equal(entry.path, 'packages/cli/src/foo.test.mjs');
  assert.equal(entry.reason, 'assertion outdated by REQ-4');
  assert.equal(entry.phase, 'implement');
  const atMs = Date.parse(entry.at);
  assert.ok(atMs >= before && atMs <= after, `entry.at (${entry.at}) should be within the call window`);
});

test('missing --reason refuses cleanly: exit non-zero, no ledger file written, no stack trace', () => {
  const { root, sessionDir } = makeProject({ phase: 'implement' });
  const r = runTestAllow(root, ['packages/cli/src/foo.test.mjs']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--reason is required/i);
  // A raw uncaught exception (addAllowance throwing straight to the top)
  // would also match "reason" in its message — this pins that the refusal
  // is a deliberate, clean usage error, not a crash.
  assert.doesNotMatch(r.stderr, /\n\s*at /, 'must not leak a stack trace');
  assert.equal(fs.existsSync(ledgerPath(sessionDir)), false);
});

test('ambiguous session (two open, active.json naming one) refuses with candidates, writes nothing', () => {
  const { root, sessionDirs } = makeAmbiguousProject();
  const r = runTestAllow(root, ['a.test.mjs', '--reason', 'some reason']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Refusing to guess which session/);
  assert.match(r.stderr, /--session s1/);
  assert.match(r.stderr, /--session s2/);
  assert.equal(fs.existsSync(ledgerPath(sessionDirs.s1)), false);
  assert.equal(fs.existsSync(ledgerPath(sessionDirs.s2)), false);
});

test('--session disambiguates: two open sessions, explicit --session s2 records into s2, not s1', () => {
  const { root, sessionDirs } = makeAmbiguousProject();
  const r = runTestAllow(root, ['a.test.mjs', '--reason', 'some reason', '--session', 's2']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(ledgerPath(sessionDirs.s1)), false);
  const ledger = JSON.parse(fs.readFileSync(ledgerPath(sessionDirs.s2), 'utf8'));
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].path, 'a.test.mjs');
});

test('an absolute path is stored repo-relative, posix-separated', () => {
  const { root, sessionDir } = makeProject({ phase: 'implement' });
  const absPath = path.join(root, 'packages', 'cli', 'src', 'foo.test.mjs');
  const r = runTestAllow(root, [absPath, '--reason', 'some reason']);
  assert.equal(r.status, 0, r.stderr);
  const ledger = JSON.parse(fs.readFileSync(ledgerPath(sessionDir), 'utf8'));
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].path, 'packages/cli/src/foo.test.mjs');
});

/** A repo with `.forge/` present (so findRepoRoot lands here) but no sessions at all. */
function makeNoSessionProject() {
  const root = tmp('test-allow-cli-nosession-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, 'a.test.mjs'), 'x\n', 'utf8');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  return root;
}

test('no open session at all refuses: exit non-zero, nothing written under .forge', () => {
  const root = makeNoSessionProject();
  const forgeDirBefore = fs.readdirSync(path.join(root, '.forge'), { recursive: true }).sort();
  const r = runTestAllow(root, ['a.test.mjs', '--reason', 'some reason']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /No active session/i);
  const forgeDirAfter = fs.readdirSync(path.join(root, '.forge'), { recursive: true }).sort();
  assert.deepEqual(forgeDirAfter, forgeDirBefore, '.forge tree must be unchanged');
});

test('a refusal (missing reason) with an existing ledger leaves it byte-identical', () => {
  const { root, sessionDir } = makeProject({ phase: 'implement' });
  const seeded =
    `${JSON.stringify([
      { path: 'packages/cli/src/other.test.mjs', reason: 'pre-existing', at: '2026-01-01T00:00:00.000Z', phase: 'implement' },
    ], null, 2)}\n`;
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(ledgerPath(sessionDir), seeded, 'utf8');

  const r = runTestAllow(root, ['packages/cli/src/foo.test.mjs']);
  assert.notEqual(r.status, 0);

  const after = fs.readFileSync(ledgerPath(sessionDir), 'utf8');
  assert.equal(after, seeded, 'ledger bytes must be untouched by a refusal');
});

test('a path outside the repo refuses: exit non-zero, message names it unguardable, nothing written', () => {
  const { root, sessionDir } = makeProject({ phase: 'implement' });
  const outside = tmp('test-allow-cli-outside-');
  const outsideFile = path.join(outside, 'x.test.mjs');
  const r = runTestAllow(root, [outsideFile, '--reason', 'some reason']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /outside the repo/i);
  assert.equal(fs.existsSync(ledgerPath(sessionDir)), false);
});

test('a second allowance for the same path appends (not replaces) and prints a prior-allowance note', () => {
  const { root, sessionDir } = makeProject({ phase: 'implement' });
  const relFile = 'packages/cli/src/foo.test.mjs';
  const first = runTestAllow(root, [relFile, '--reason', 'first reason']);
  assert.equal(first.status, 0, first.stderr);
  assert.doesNotMatch(first.stdout, /prior allowance/i);

  const second = runTestAllow(root, [relFile, '--reason', 'second reason']);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /prior allowance/i);
  assert.match(second.stdout, /first reason/);

  const ledger = JSON.parse(fs.readFileSync(ledgerPath(sessionDir), 'utf8'));
  assert.equal(ledger.length, 2);
  assert.equal(ledger[0].reason, 'first reason');
  assert.equal(ledger[1].reason, 'second reason');
});

test('--json prints the documented entry shape', () => {
  const { root } = makeProject({ phase: 'implement' });
  const r = runTestAllow(root, ['packages/cli/src/foo.test.mjs', '--reason', 'some reason', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out).sort(), ['at', 'path', 'phase', 'reason'].sort());
  assert.equal(out.path, 'packages/cli/src/foo.test.mjs');
  assert.equal(out.reason, 'some reason');
  assert.equal(out.phase, 'implement');
});

test('integration: recording an allowance flips a subsequent `forge guard check` from deny to allow', () => {
  const { root } = makeProject({ phase: 'implement' });
  const relFile = 'packages/cli/src/foo.test.mjs';
  const bin = path.join(SRC, '..', 'bin', 'forge.mjs');

  const denied = spawnSync(
    process.execPath,
    [bin, 'guard', 'check', '--file', relFile, '--json'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(denied.status, 2, denied.stderr);
  assert.equal(JSON.parse(denied.stdout).decision, 'deny');

  const recorded = spawnSync(
    process.execPath,
    [bin, 'test-allow', relFile, '--reason', 'assertion outdated by REQ-4'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(recorded.status, 0, recorded.stderr);

  const allowed = spawnSync(
    process.execPath,
    [bin, 'guard', 'check', '--file', relFile, '--json'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(allowed.status, 0, allowed.stderr);
  const out = JSON.parse(allowed.stdout);
  assert.equal(out.decision, 'allow');
  assert.equal(out.reason, 'allowance');
  assert.equal(out.allowanceReason, 'assertion outdated by REQ-4');
});

test('missing <path> is a usage error: exit non-zero, no ledger file written', () => {
  const { root, sessionDir } = makeProject({ phase: 'implement' });
  const r = runTestAllow(root, ['--reason', 'some reason']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage: forge test-allow/);
  assert.equal(fs.existsSync(ledgerPath(sessionDir)), false);
});

test('whitespace-only --reason refuses: exit non-zero, no ledger file written', () => {
  const { root, sessionDir } = makeProject({ phase: 'implement' });
  const r = runTestAllow(root, ['packages/cli/src/foo.test.mjs', '--reason', '   ']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--reason is required/i);
  assert.equal(fs.existsSync(ledgerPath(sessionDir)), false);
});
