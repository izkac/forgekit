import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const GUARD_CLI = path.join(SRC, 'guard-cli.mjs');

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A scratch project: a git repo with one committed baseline test file and
 * one committed plain (non-test) file, a Forge session under `.forge/`
 * carrying the given `phase`/`baseCommit`, and `.forge/active.json` pointing
 * at it. A second test file is created *after* the commit (untracked at
 * baseCommit) so session-created-test-is-unguarded is a real, discriminating
 * case rather than a fixture where every candidate looks the same.
 */
function makeProject({
  phase = 'implement',
  sessionId = 's1',
  baseCommit: baseCommitOverride,
  testGlobs,
} = {}) {
  const root = tmp('guard-cli-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  fs.mkdirSync(path.join(root, 'packages', 'cli', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages', 'cli', 'src', 'foo.test.mjs'), 'baseline\n', 'utf8');
  fs.writeFileSync(path.join(root, 'packages', 'cli', 'src', 'plain.mjs'), 'code\n', 'utf8');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const baseCommit = git(root, 'rev-parse', 'HEAD');
  // Created after the commit: must read as untracked at baseCommit.
  fs.writeFileSync(path.join(root, 'packages', 'cli', 'src', 'new.test.mjs'), 'new\n', 'utf8');

  const sessionDir = path.join(root, '.forge', 'sessions', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const session = {
    id: sessionId,
    slug: 'fixture',
    phase,
    ...(baseCommitOverride === undefined ? { baseCommit } : baseCommitOverride === null ? {} : { baseCommit: baseCommitOverride }),
  };
  fs.writeFileSync(path.join(sessionDir, 'session.json'), `${JSON.stringify(session)}\n`, 'utf8');
  fs.writeFileSync(path.join(root, '.forge', 'active.json'), `${JSON.stringify({ sessionId })}\n`, 'utf8');
  if (testGlobs) {
    fs.writeFileSync(
      path.join(root, '.forge', 'config.json'),
      `${JSON.stringify({ guard: { testGlobs } })}\n`,
      'utf8',
    );
  }
  return { root, sessionDir, sessionId, baseCommit };
}

function runGuard(cwd, args) {
  return spawnSync(process.execPath, [GUARD_CLI, ...args], { cwd, encoding: 'utf8' });
}

/**
 * A repo whose `.forge/sessions` cannot be enumerated: a file sits where the
 * directory should be, so `fs.readdirSync` throws ENOTDIR. `unfinishedSessions`
 * reports that as "could not read" (`null`), distinct from "no sessions" (`[]`)
 * — the case a laundered no-session allow would swallow silently.
 */
function makeUnreadableSessionsProject() {
  const root = tmp('guard-cli-unreadable-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, 'a.test.mjs'), 'x\n', 'utf8');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(root, '.forge', 'sessions'), 'not a directory\n', 'utf8');
  return root;
}

/**
 * Two open (non-terminal) sessions with `.forge/active.json` naming neither —
 * `resolveSessionId` cannot pick one and returns `id: null` with `problem` set,
 * distinct from the genuine "no sessions at all" case.
 */
function makeAmbiguousProject() {
  const root = tmp('guard-cli-ambiguous-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, 'a.test.mjs'), 'x\n', 'utf8');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  for (const id of ['s1', 's2']) {
    const dir = path.join(root, '.forge', 'sessions', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'session.json'),
      `${JSON.stringify({ id, slug: id, phase: 'implement' })}\n`,
      'utf8',
    );
  }
  fs.writeFileSync(
    path.join(root, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId: 'neither-of-them' })}\n`,
    'utf8',
  );
  return root;
}

test('missing --file is a usage error: exit 1', () => {
  const { root } = makeProject();
  const r = runGuard(root, ['check']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: forge guard check/);
});

test('a --file value that looks like a flag is treated as missing, not consumed as the filename', () => {
  // `--file --json` must not silently treat "--json" as the file to check
  // (and so never set the json flag, and never classify a bogus "file").
  const { root } = makeProject();
  const r = runGuard(root, ['check', '--file', '--json']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: forge guard check/);
});

test('an unreadable .forge/sessions directory fails open with a stderr warning, not silently', () => {
  const root = makeUnreadableSessionsProject();
  const r = runGuard(root, ['check', '--file', 'a.test.mjs', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'allow');
  assert.equal(out.reason, 'no-session');
  assert.match(r.stderr, /\[forge\] Warning:/);
  assert.match(r.stderr, /could not read/);
});

test('two unfinished sessions with active.json naming neither fails open with a stderr warning, not silently', () => {
  const root = makeAmbiguousProject();
  const r = runGuard(root, ['check', '--file', 'a.test.mjs', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'allow');
  assert.equal(out.reason, 'no-session');
  assert.match(r.stderr, /\[forge\] Warning:/);
  assert.match(r.stderr, /unfinished/);
});

test('a --file outside the repo root allows with reason outside-repo', () => {
  const { root } = makeProject();
  const outside = tmp('guard-cli-outside-');
  const r = runGuard(root, ['check', '--file', path.join(outside, 'x.test.mjs'), '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'allow');
  assert.equal(out.reason, 'outside-repo');
});

test('no open session allows with reason no-session', () => {
  const root = tmp('guard-cli-nosession-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, 'a.test.mjs'), 'x\n', 'utf8');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  // .forge exists (so findRepoRoot lands here) but has no sessions at all.
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });

  const r = runGuard(root, ['check', '--file', 'a.test.mjs', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'allow');
  assert.equal(out.reason, 'no-session');
  assert.equal(out.sessionId, null);
});

for (const phase of ['triage', 'brainstorm', 'plan', 'done', 'skipped']) {
  test(`phase "${phase}" is out of window: allows a guarded file`, () => {
    const { root } = makeProject({ phase });
    const r = runGuard(root, ['check', '--file', 'packages/cli/src/foo.test.mjs', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'allow');
    assert.equal(out.reason, 'phase-out-of-window');
  });
}

for (const phase of ['implement', 'verify', 'review', 'finish']) {
  test(`phase "${phase}" is in window: denies a guarded baseline test with no allowance`, () => {
    const { root } = makeProject({ phase });
    const r = runGuard(root, ['check', '--file', 'packages/cli/src/foo.test.mjs', '--json']);
    assert.equal(r.status, 2, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'deny');
    assert.equal(out.rule, '**/*.test.*');
  });
}

test('an unguarded (non-test) file allows with reason not-guarded, in an in-window phase', () => {
  const { root } = makeProject({ phase: 'implement' });
  const r = runGuard(root, ['check', '--file', 'packages/cli/src/plain.mjs', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'allow');
  assert.equal(out.reason, 'not-guarded');
});

test('a test file created during the session (untracked at baseCommit) allows with reason not-guarded', () => {
  const { root } = makeProject({ phase: 'implement' });
  const r = runGuard(root, ['check', '--file', 'packages/cli/src/new.test.mjs', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'allow');
  assert.equal(out.reason, 'not-guarded');
});

test('a recorded allowance flips a deny to an allow, and its reason surfaces in the output', () => {
  const { root, sessionDir } = makeProject({ phase: 'implement' });
  const relFile = 'packages/cli/src/foo.test.mjs';

  const denied = runGuard(root, ['check', '--file', relFile, '--json']);
  assert.equal(denied.status, 2, denied.stderr);

  fs.writeFileSync(
    path.join(sessionDir, 'guard-allowances.json'),
    `${JSON.stringify([{ path: relFile, reason: 'assertion outdated by REQ-4 change', at: new Date().toISOString(), phase: 'implement' }])}\n`,
    'utf8',
  );

  const allowed = runGuard(root, ['check', '--file', relFile, '--json']);
  assert.equal(allowed.status, 0, allowed.stderr);
  const out = JSON.parse(allowed.stdout);
  assert.equal(out.decision, 'allow');
  assert.equal(out.reason, 'allowance');
  assert.equal(out.allowanceReason, 'assertion outdated by REQ-4 change');
});

test('deny message names the matched glob rule and the forge test-allow escape', () => {
  const { root } = makeProject({ phase: 'implement' });
  const relFile = 'packages/cli/src/foo.test.mjs';
  const r = runGuard(root, ['check', '--file', relFile]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /\*\*\/\*\.test\.\*/, 'names the matched glob');
  assert.match(r.stdout, new RegExp(`forge test-allow ${relFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} --reason`));
});

test('F92: the printed escape names the governing session via --session', () => {
  const { root, sessionId } = makeProject({ phase: 'implement' });
  const r = runGuard(root, ['check', '--file', 'packages/cli/src/foo.test.mjs']);
  assert.equal(r.status, 2);
  assert.match(
    r.stdout,
    new RegExp(`forge test-allow .* --session ${sessionId}`),
    'the escape must work verbatim even with a second in-window session open',
  );
});

test('deny message for an integrity-artifact rule reads sensibly for an unrelated file with that basename', () => {
  const { root } = makeProject({ phase: 'implement' });
  // Not the session's own spine — an unrelated file that merely shares the
  // protected basename, to force the message to describe the *class*, not
  // claim this file "is" the session's spine.
  const artifactDir = path.join(root, 'specs', 'changes', 'unrelated-change');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'spine.json'), '{}\n', 'utf8');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'add unrelated spine.json');

  const relFile = 'specs/changes/unrelated-change/spine.json';
  const r = runGuard(root, ['check', '--file', relFile]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /spine\.json/);
  assert.doesNotMatch(r.stdout, /is the session's spine/i);
  assert.match(r.stdout, /forge test-allow/);
});

test('--json prints the documented shape', () => {
  const { root } = makeProject({ phase: 'implement' });
  const r = runGuard(root, ['check', '--file', 'packages/cli/src/plain.mjs', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out).sort(), ['decision', 'file', 'reason', 'rule', 'sessionId'].sort());
  assert.equal(out.decision, 'allow');
  assert.equal(out.file, 'packages/cli/src/plain.mjs');
  assert.equal(out.rule, null);
});

test('missing baseCommit fails open: allow, reason no-base-commit, exit 0, with a stderr warning', () => {
  const { root } = makeProject({ phase: 'implement', baseCommit: null });
  const r = runGuard(root, ['check', '--file', 'packages/cli/src/foo.test.mjs', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'allow');
  assert.equal(out.reason, 'no-base-commit');
  assert.match(r.stderr, /no baseCommit/);
});

test('a git failure (unresolvable baseCommit) is an internal error: exit 1, never 2', () => {
  const { root } = makeProject({ phase: 'implement', baseCommit: 'not-a-real-commit-sha' });
  const r = runGuard(root, ['check', '--file', 'packages/cli/src/foo.test.mjs', '--json']);
  assert.equal(r.status, 1, r.stdout);
  assert.notEqual(r.status, 2, 'an internal error must never be reported as deny');
  assert.match(r.stderr, /git ls-tree/);
});

test('an absolute --file path is treated the same as its repo-relative equivalent', () => {
  const { root } = makeProject({ phase: 'implement' });
  const relFile = 'packages/cli/src/foo.test.mjs';
  const absFile = path.join(root, relFile);
  const rel = runGuard(root, ['check', '--file', relFile, '--json']);
  const abs = runGuard(root, ['check', '--file', absFile, '--json']);
  assert.equal(rel.status, abs.status);
  const relOut = JSON.parse(rel.stdout);
  const absOut = JSON.parse(abs.stdout);
  assert.deepEqual(relOut, absOut);
});

test('the command is registered under `forge guard`: a deny (exit 2) survives the bin wrapper', () => {
  // Every test above spawns guard-cli.mjs directly. That proves the decision
  // table but nothing about wiring: deleting the `guard` entry from
  // bin/forge.mjs's COMMANDS map would leave this suite green right up until
  // the hook (task 3.1) tries to run `forge guard check` and finds "Unknown
  // command". The future hook depends specifically on
  // `process.exit(r.status ?? 1)` in bin/forge.mjs propagating a non-zero,
  // non-1 status through unchanged — exit 2 is what tells it "deny", not
  // "internal error, fail open".
  const { root } = makeProject({ phase: 'implement' });
  const bin = path.join(SRC, '..', 'bin', 'forge.mjs');
  const r = spawnSync(
    process.execPath,
    [bin, 'guard', 'check', '--file', 'packages/cli/src/foo.test.mjs', '--json'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(r.status, 2, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'deny');
  assert.match(
    fs.readFileSync(bin, 'utf8'),
    /^ {2}guard: /m,
    'a registered command missing from COMMANDS would make this unreachable',
  );
});

// --- C1: `.forge/config.json` is Forge's own guard control surface --------

test('C1: .forge/config.json is denied during implement — it cannot be rewritten to disable the guard', () => {
  const { root } = makeProject({ phase: 'implement' });
  const r = runGuard(root, ['check', '--file', '.forge/config.json', '--json']);
  assert.equal(r.status, 2, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'deny');
  assert.equal(out.rule, 'forge-control:config.json');
});

test('C1: .forge/config.json is unrestricted outside the enforcement window', () => {
  const { root } = makeProject({ phase: 'plan' });
  const r = runGuard(root, ['check', '--file', '.forge/config.json', '--json']);
  assert.equal(r.status, 0, r.stderr);
});

test('C1: guard.testGlobs: [] does not disable the guard — the CLI still denies the baseline test', () => {
  const { root } = makeProject({ phase: 'implement', testGlobs: [] });
  const r = runGuard(root, ['check', '--file', 'packages/cli/src/foo.test.mjs', '--json']);
  assert.equal(r.status, 2, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'deny');
  assert.match(r.stderr, /testGlobs/);
});

// --- C2: session.json / active.json are the guard's trust anchor ----------

test('C2: a session\'s own session.json is denied during implement — baseCommit/features cannot be rewritten via a tool call', () => {
  const { root, sessionId } = makeProject({ phase: 'implement' });
  const r = runGuard(root, ['check', '--file', `.forge/sessions/${sessionId}/session.json`, '--json']);
  assert.equal(r.status, 2, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'deny');
  assert.equal(out.rule, 'forge-control:session.json');
});

test('C2: .forge/active.json is denied during implement', () => {
  const { root } = makeProject({ phase: 'implement' });
  const r = runGuard(root, ['check', '--file', '.forge/active.json', '--json']);
  assert.equal(r.status, 2, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'deny');
  assert.equal(out.rule, 'forge-control:active.json');
});

// --- C3: a second concurrent session must not turn the guard off globally -

test('C3: a decoy out-of-window session named by active.json does not shadow an in-window session that guards the file', () => {
  const { root, sessionId } = makeProject({ phase: 'implement' });
  const decoyId = 'decoy-session';
  const decoyDir = path.join(root, '.forge', 'sessions', decoyId);
  fs.mkdirSync(decoyDir, { recursive: true });
  fs.writeFileSync(
    path.join(decoyDir, 'session.json'),
    `${JSON.stringify({ id: decoyId, slug: 'decoy', phase: 'triage' })}\n`,
    'utf8',
  );
  // The mutable pointer now names the decoy, not the real (guarding) session.
  fs.writeFileSync(path.join(root, '.forge', 'active.json'), `${JSON.stringify({ sessionId: decoyId })}\n`, 'utf8');

  const r = runGuard(root, ['check', '--file', 'packages/cli/src/foo.test.mjs', '--json']);
  assert.equal(r.status, 2, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'deny');
  assert.equal(out.sessionId, sessionId, 'the deny must name the session that actually guards the file');
});

test('C3: an explicit --session still evaluates only the named session (no cross-session fan-out)', () => {
  const { root, sessionId } = makeProject({ phase: 'implement' });
  const decoyId = 'decoy-session-2';
  const decoyDir = path.join(root, '.forge', 'sessions', decoyId);
  fs.mkdirSync(decoyDir, { recursive: true });
  fs.writeFileSync(
    path.join(decoyDir, 'session.json'),
    `${JSON.stringify({ id: decoyId, slug: 'decoy', phase: 'plan' })}\n`,
    'utf8',
  );
  const r = runGuard(root, ['check', '--file', 'packages/cli/src/foo.test.mjs', '--json', '--session', decoyId]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'allow');
  assert.equal(out.reason, 'phase-out-of-window');
  assert.equal(out.sessionId, decoyId);
  void sessionId; // unused here — this test is about the explicit-session path only
});

// --- F91: a broken primary session must not fail open for every file -----

test('F91: an unparseable primary session.json still lets the cross-session sweep deny', () => {
  const { root, sessionDir } = makeProject({ phase: 'implement' });
  // Torn write on the session active.json points at.
  fs.writeFileSync(path.join(sessionDir, 'session.json'), '{ "id": "s1",\n', 'utf8');
  // A second, healthy in-window session guards the baseline test.
  const otherId = 's2';
  const otherDir = path.join(root, '.forge', 'sessions', otherId);
  fs.mkdirSync(otherDir, { recursive: true });
  const baseCommit = git(root, 'rev-parse', 'HEAD');
  fs.writeFileSync(
    path.join(otherDir, 'session.json'),
    `${JSON.stringify({ id: otherId, slug: 'other', phase: 'implement', baseCommit })}\n`,
    'utf8',
  );

  const r = runGuard(root, ['check', '--file', 'packages/cli/src/foo.test.mjs', '--json']);
  assert.equal(r.status, 2, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'deny');
  assert.equal(out.sessionId, otherId, 'the deny must come from the healthy sweeping session');
});

// --- I4: verify-evidence.md is authored during verify, so it must not be --
// --- frozen before verify begins (F88) --------------------------------

test('I4: verify-evidence.md is editable during verify (its own authoring phase)', () => {
  const { root, sessionDir } = makeProject({ phase: 'verify' });
  const file = path.join(sessionDir, 'verify-evidence.md');
  fs.writeFileSync(file, '# Verify evidence\n', 'utf8');
  const rel = path.relative(root, file).split(path.sep).join('/');
  const r = runGuard(root, ['check', '--file', rel, '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'allow');
  assert.equal(out.reason, 'phase-out-of-window');
});

test('I4: verify-evidence.md is frozen from review onward', () => {
  const { root, sessionDir } = makeProject({ phase: 'review' });
  const file = path.join(sessionDir, 'verify-evidence.md');
  fs.writeFileSync(file, '# Verify evidence\n', 'utf8');
  const rel = path.relative(root, file).split(path.sep).join('/');
  const r = runGuard(root, ['check', '--file', rel, '--json']);
  assert.equal(r.status, 2, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'deny');
  assert.equal(out.rule, 'integrity-artifact:verify-evidence.md');
});

test('I4: verify-evidence.md is unrestricted at implement too — nothing legitimate touches it before its own authoring phase', () => {
  // The per-rule window is symmetric with spine/e2e: unrestricted before the
  // owning phase, frozen once that phase's work should be settled. Real
  // protection against a tamper made *during* implement still comes from the
  // backstop (`checkGuardedFiles` at done), which is phase-blind by design —
  // loosening this window does not loosen that.
  const { root, sessionDir } = makeProject({ phase: 'implement' });
  const file = path.join(sessionDir, 'verify-evidence.md');
  fs.writeFileSync(file, '# Verify evidence\n', 'utf8');
  const rel = path.relative(root, file).split(path.sep).join('/');
  const r = runGuard(root, ['check', '--file', rel, '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'allow');
  assert.equal(out.reason, 'phase-out-of-window');
});

test('I4: openspec-verify.md is editable during verify (its own authoring phase)', () => {
  const { root, sessionDir } = makeProject({ phase: 'verify' });
  const file = path.join(sessionDir, 'openspec-verify.md');
  fs.writeFileSync(file, '# OpenSpec verify\n', 'utf8');
  const rel = path.relative(root, file).split(path.sep).join('/');
  const r = runGuard(root, ['check', '--file', rel, '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'allow');
  assert.equal(out.reason, 'phase-out-of-window');
});

test('I4: openspec-verify.md is frozen from review onward', () => {
  const { root, sessionDir } = makeProject({ phase: 'review' });
  const file = path.join(sessionDir, 'openspec-verify.md');
  fs.writeFileSync(file, '# OpenSpec verify\n', 'utf8');
  const rel = path.relative(root, file).split(path.sep).join('/');
  const r = runGuard(root, ['check', '--file', rel, '--json']);
  assert.equal(r.status, 2, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'deny');
  assert.equal(out.rule, 'integrity-artifact:openspec-verify.md');
});

test('I4: spec-verify.md is editable during verify (its own authoring phase)', () => {
  const { root, sessionDir } = makeProject({ phase: 'verify' });
  const file = path.join(sessionDir, 'spec-verify.md');
  fs.writeFileSync(file, '# Spec verify\n', 'utf8');
  const rel = path.relative(root, file).split(path.sep).join('/');
  const r = runGuard(root, ['check', '--file', rel, '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'allow');
  assert.equal(out.reason, 'phase-out-of-window');
});

test('I4: spec-verify.md is frozen from review onward', () => {
  const { root, sessionDir } = makeProject({ phase: 'review' });
  const file = path.join(sessionDir, 'spec-verify.md');
  fs.writeFileSync(file, '# Spec verify\n', 'utf8');
  const rel = path.relative(root, file).split(path.sep).join('/');
  const r = runGuard(root, ['check', '--file', rel, '--json']);
  assert.equal(r.status, 2, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'deny');
  assert.equal(out.rule, 'integrity-artifact:spec-verify.md');
});

test('I4: a different integrity artifact (spine.json) keeps the default window — frozen from implement onward, unaffected by the verify-evidence.md refinement', () => {
  const { root, sessionDir } = makeProject({ phase: 'implement' });
  const file = path.join(sessionDir, 'spine.json');
  fs.writeFileSync(file, '{}\n', 'utf8');
  const rel = path.relative(root, file).split(path.sep).join('/');
  const r = runGuard(root, ['check', '--file', rel, '--json']);
  assert.equal(r.status, 2, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'deny');
  assert.equal(out.rule, 'integrity-artifact:spine.json');
});

test('a project guard.testGlobs override reaches the CLI end-to-end: an overridden-out file allows as not-guarded', () => {
  // `makeProject`'s `testGlobs` knob writes .forge/config.json; this is the
  // one test that actually passes it and checks the CLI honors it, rather
  // than only the classifier (guard.test.mjs) or a dead fixture parameter.
  const { root } = makeProject({ phase: 'implement', testGlobs: ['spec/**'] });
  const r = runGuard(root, ['check', '--file', 'packages/cli/src/foo.test.mjs', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'allow');
  assert.equal(out.reason, 'not-guarded');
});
