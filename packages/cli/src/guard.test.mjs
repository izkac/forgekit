import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  classifyGuarded,
  loadAllowances,
  addAllowance,
  hasAllowance,
  findAllowance,
  makeGitLsTree,
} from './guard.mjs';

function tmpSessionDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'guard-ledger-'));
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A scratch repo with one committed file and one untracked file. */
function makeScratchRepo() {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-git-')));
  git(cwd, ['init', '-q', '-b', 'main']);
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['config', 'user.name', 'Test']);
  fs.mkdirSync(path.join(cwd, 'packages', 'cli', 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'packages', 'cli', 'src', 'foo.test.mjs'), 'baseline\n', 'utf8');
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', 'base']);
  const baseCommit = git(cwd, ['rev-parse', 'HEAD']);
  // Created after the commit — must read as untracked at baseCommit.
  fs.writeFileSync(path.join(cwd, 'packages', 'cli', 'src', 'new.test.mjs'), 'new\n', 'utf8');
  return { cwd, baseCommit };
}

test('a path matching a default test glob and tracked at baseCommit is guarded', () => {
  const tracked = new Set(['packages/cli/src/foo.test.mjs']);
  const result = classifyGuarded({
    relPath: 'packages/cli/src/foo.test.mjs',
    config: {},
    gitLsTree: (p) => tracked.has(p),
  });
  assert.equal(result.guarded, true);
  assert.equal(result.rule, '**/*.test.*');
});

test('a path matching a default test glob but NOT tracked at baseCommit is not guarded (session-created test)', () => {
  const tracked = new Set(); // nothing tracked — the file was created this session
  const result = classifyGuarded({
    relPath: 'packages/cli/src/new-thing.test.mjs',
    config: {},
    gitLsTree: (p) => tracked.has(p),
  });
  assert.equal(result.guarded, false);
  assert.equal(result.rule, null);
});

test('each default glob matches its positive fixtures and rejects its negative fixtures', () => {
  const cases = [
    { path: 'x/foo.test.mjs', glob: '**/*.test.*', expect: true },
    { path: 'foo.test.js', glob: '**/*.test.*', expect: true },
    { path: 'foo.mjs', glob: '**/*.test.*', expect: false },
    { path: 'x/foo.spec.mjs', glob: '**/*.spec.*', expect: true },
    { path: 'foo.spec.js', glob: '**/*.spec.*', expect: true },
    { path: 'foo.mjs', glob: '**/*.spec.*', expect: false },
    { path: 'a/__tests__/b.mjs', glob: '**/__tests__/**', expect: true },
    { path: '__tests__/b.mjs', glob: '**/__tests__/**', expect: true },
    { path: 'a/__testsxx__/b.mjs', glob: '**/__tests__/**', expect: false },
    { path: 'a/test/b.mjs', glob: '**/test/**', expect: true },
    { path: 'test/b.mjs', glob: '**/test/**', expect: true },
    { path: 'attest/b.mjs', glob: '**/test/**', expect: false },
    { path: 'a/tests/b.mjs', glob: '**/tests/**', expect: true },
    { path: 'tests/b.mjs', glob: '**/tests/**', expect: true },
    { path: 'attests/b.mjs', glob: '**/tests/**', expect: false },
    // `*` must stay within one path segment ([^/]*), not swallow a `/` like
    // `.*` would. If `*` matched across segments, '*.spec.*' would greedily
    // consume 'x/inner.mjs' as the trailing '*' and wrongly match.
    { path: 'a.spec.x/inner.mjs', glob: '**/*.spec.*', expect: false },
  ];
  for (const { path: relPath, glob, expect } of cases) {
    // Every fixture is tracked, so only glob matching decides guarded/not —
    // the case is isolated from the tracked-vs-untracked behavior already
    // covered above.
    const result = classifyGuarded({
      relPath,
      config: {},
      gitLsTree: () => true,
    });
    assert.equal(
      result.guarded,
      expect,
      `${relPath} vs ${glob}: expected guarded=${expect}, got ${result.guarded} (rule=${result.rule})`,
    );
  }
});

test('loadAllowances returns [] when the ledger file does not exist', () => {
  const sessionDir = tmpSessionDir();
  assert.deepEqual(loadAllowances(sessionDir), []);
});

test('loadAllowances throws a descriptive Error on malformed JSON', () => {
  const sessionDir = tmpSessionDir();
  fs.writeFileSync(path.join(sessionDir, 'guard-allowances.json'), '{ not valid json', 'utf8');
  assert.throws(() => loadAllowances(sessionDir), /guard-allowances\.json/);
});

test('loadAllowances throws when the ledger is valid JSON but not an array', () => {
  const sessionDir = tmpSessionDir();
  fs.writeFileSync(
    path.join(sessionDir, 'guard-allowances.json'),
    JSON.stringify({ oops: 'not an array' }),
    'utf8',
  );
  assert.throws(() => loadAllowances(sessionDir), /guard-allowances\.json/);
});

test('addAllowance appends an entry that loadAllowances reads back', () => {
  const sessionDir = tmpSessionDir();
  const before = Date.now();
  const entry = addAllowance(sessionDir, {
    path: 'packages/cli/src/foo.test.mjs',
    reason: 'assertion outdated by REQ-4 change',
    phase: 'implement',
  });
  const after = Date.now();

  assert.equal(entry.path, 'packages/cli/src/foo.test.mjs');
  assert.equal(entry.reason, 'assertion outdated by REQ-4 change');
  assert.equal(entry.phase, 'implement');
  const atMs = Date.parse(entry.at);
  assert.ok(atMs >= before && atMs <= after, `entry.at (${entry.at}) should be within the call window`);

  const loaded = loadAllowances(sessionDir);
  assert.deepEqual(loaded, [entry]);
});

test('addAllowance refuses an empty or whitespace-only reason and writes nothing', () => {
  const sessionDir = tmpSessionDir();
  assert.throws(() => addAllowance(sessionDir, { path: 'a.test.mjs', reason: '' }));
  assert.throws(() => addAllowance(sessionDir, { path: 'a.test.mjs', reason: '   ' }));
  assert.deepEqual(loadAllowances(sessionDir), []);
});

test('addAllowance refuses a missing path', () => {
  const sessionDir = tmpSessionDir();
  assert.throws(() => addAllowance(sessionDir, { reason: 'valid reason' }));
});

test('hasAllowance is an exact match, not a prefix match', () => {
  const allowances = [{ path: 'packages/cli/src/foo.test.mjs', reason: 'r', at: 'x', phase: null }];
  assert.equal(hasAllowance(allowances, 'packages/cli/src/foo.test.mjs'), true);
  assert.equal(hasAllowance(allowances, 'packages/cli/src/foo.test.mjs.bak'), false);
  assert.equal(hasAllowance(allowances, 'packages/cli/src/foo'), false);
});

test('findAllowance returns the matching entry (exact match, not prefix), or null', () => {
  const match = { path: 'packages/cli/src/foo.test.mjs', reason: 'r1', at: 'x', phase: null };
  const other = { path: 'packages/cli/src/bar.test.mjs', reason: 'r2', at: 'y', phase: null };
  const allowances = [other, match];
  assert.deepEqual(findAllowance(allowances, 'packages/cli/src/foo.test.mjs'), match);
  assert.equal(findAllowance(allowances, 'packages/cli/src/foo.test.mjs.bak'), null);
  assert.equal(findAllowance([], 'packages/cli/src/foo.test.mjs'), null);
});

test('classifyGuarded accepts the full documented call shape, including session', () => {
  // session carries no weight in the decision — baseCommit tracking is fully
  // delegated to gitLsTree — but the exported signature accepts it for
  // parity with the hook/integrity-backstop callers (tasks 2.1/4.1).
  const tracked = new Set(['packages/cli/src/foo.test.mjs']);
  const result = classifyGuarded({
    relPath: 'packages/cli/src/foo.test.mjs',
    session: { baseCommit: 'deadbeef', phase: 'implement' },
    config: {},
    gitLsTree: (p) => tracked.has(p),
  });
  assert.equal(result.guarded, true);
});

test('makeGitLsTree reports tracked files true and untracked/nonexistent files false', () => {
  const { cwd, baseCommit } = makeScratchRepo();
  const gitLsTree = makeGitLsTree({ cwd, baseCommit });
  assert.equal(gitLsTree('packages/cli/src/foo.test.mjs'), true);
  assert.equal(gitLsTree('packages/cli/src/new.test.mjs'), false);
  assert.equal(gitLsTree('packages/cli/src/does-not-exist.mjs'), false);
});

test('makeGitLsTree throws a descriptive Error when the commit does not exist', () => {
  const { cwd } = makeScratchRepo();
  const gitLsTree = makeGitLsTree({ cwd, baseCommit: 'not-a-real-commit-sha' });
  assert.throws(() => gitLsTree('packages/cli/src/foo.test.mjs'), /git ls-tree/);
});

test('makeGitLsTree tracks a non-ASCII filename despite core.quotepath', () => {
  // git's default core.quotepath=true renders non-ASCII/quote/backslash
  // bytes in `git ls-tree` output as a quoted, octal-escaped string (e.g.
  // "tests/caf\303\251.test.mjs") on a plain newline-delimited listing.
  // `-z` (NUL-terminated, unquoted) sidesteps that entirely.
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-git-')));
  git(cwd, ['init', '-q', '-b', 'main']);
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['config', 'user.name', 'Test']);
  fs.mkdirSync(path.join(cwd, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'tests', 'café.test.mjs'), 'baseline\n', 'utf8');
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', 'base']);
  const baseCommit = git(cwd, ['rev-parse', 'HEAD']);

  const gitLsTree = makeGitLsTree({ cwd, baseCommit });
  assert.equal(gitLsTree('tests/café.test.mjs'), true);
});

test('a windows-separator path is normalized before matching', () => {
  const tracked = new Set(['packages/cli/src/foo.test.mjs']);
  const result = classifyGuarded({
    relPath: 'packages\\cli\\src\\foo.test.mjs',
    config: {},
    gitLsTree: (p) => tracked.has(p),
  });
  assert.equal(result.guarded, true);
  assert.equal(result.rule, '**/*.test.*');
});

test('integrity artifacts are guarded regardless of tracking state, in a subdirectory', () => {
  const untracked = () => false; // never tracked — proves age/tracking is irrelevant here
  const artifacts = [
    'spine.json',
    'e2e.json',
    'e2e-results.json',
    'verify-evidence.md',
    'test-evidence.md',
    'tdd-runs.jsonl',
  ];
  for (const basename of artifacts) {
    const relPath = `specs/changes/x/${basename}`;
    const result = classifyGuarded({ relPath, config: {}, gitLsTree: untracked });
    assert.equal(result.guarded, true, `${basename} should be guarded`);
    assert.equal(result.rule, `integrity-artifact:${basename}`);
  }
});

test('a project testGlobs override replaces (not extends) the defaults', () => {
  const tracked = new Set(['packages/cli/src/foo.test.mjs']);
  const result = classifyGuarded({
    relPath: 'packages/cli/src/foo.test.mjs',
    config: { guard: { testGlobs: ['spec/**'] } },
    gitLsTree: (p) => tracked.has(p),
  });
  assert.equal(result.guarded, false);
  assert.equal(result.rule, null);
});

// --- C1: `guard.testGlobs: []` must not silently disable the guard --------

test('C1: an empty testGlobs override falls back to defaults instead of guarding nothing', () => {
  const tracked = new Set(['packages/cli/src/foo.test.mjs']);
  const result = classifyGuarded({
    relPath: 'packages/cli/src/foo.test.mjs',
    config: { guard: { testGlobs: [] } },
    gitLsTree: (p) => tracked.has(p),
  });
  assert.equal(result.guarded, true, 'an empty override is a configuration error, not an opt-out to guard nothing');
  assert.equal(result.rule, '**/*.test.*');
  assert.match(result.warning ?? '', /testGlobs/);
});

test('C1: a whitespace-only testGlobs override also falls back to defaults', () => {
  const tracked = new Set(['packages/cli/src/foo.test.mjs']);
  const result = classifyGuarded({
    relPath: 'packages/cli/src/foo.test.mjs',
    config: { guard: { testGlobs: ['   ', ''] } },
    gitLsTree: (p) => tracked.has(p),
  });
  assert.equal(result.guarded, true);
  assert.match(result.warning ?? '', /testGlobs/);
});

test('C1/C2: a well-formed testGlobs override never carries the invalid-override warning', () => {
  const tracked = new Set(['packages/cli/src/foo.test.mjs']);
  const result = classifyGuarded({
    relPath: 'packages/cli/src/foo.test.mjs',
    config: { guard: { testGlobs: ['**/*.test.*'] } },
    gitLsTree: (p) => tracked.has(p),
  });
  assert.equal(result.guarded, true);
  assert.equal(result.warning, null);
});

// --- C1/C2: Forge's own control surface is guarded unconditionally --------

test('C1/C2: .forge/config.json, active.json, and any session.json are guarded regardless of tracking state or testGlobs', () => {
  const neverTracked = () => false;
  const cases = [
    { relPath: '.forge/config.json', rule: 'forge-control:config.json' },
    { relPath: '.forge/active.json', rule: 'forge-control:active.json' },
    { relPath: '.forge/sessions/20260101T000000Z-x-1234ab/session.json', rule: 'forge-control:session.json' },
  ];
  for (const { relPath, rule } of cases) {
    // testGlobs override set to something that would never match these paths —
    // proves the rule is unconditional, not a lucky glob match.
    const result = classifyGuarded({
      relPath,
      config: { guard: { testGlobs: ['nothing/**'] } },
      gitLsTree: neverTracked,
    });
    assert.equal(result.guarded, true, `${relPath} should be guarded`);
    assert.equal(result.rule, rule);
  }
});

test('C1/C2: a same-named file outside .forge/ is not swept up by the control-surface rule', () => {
  const result = classifyGuarded({
    relPath: 'some/other/project/config.json',
    config: {},
    gitLsTree: () => false,
  });
  assert.equal(result.guarded, false);
});
