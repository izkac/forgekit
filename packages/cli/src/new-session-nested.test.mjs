import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * `forge new` records the HEAD of every nested git repository (at most two
 * directory levels below the project root) in `session.nestedBaseCommits`,
 * keyed by posix relative path, so group-tier `--changedSince=<base>` works
 * in nested repos too.
 */

const SRC = path.dirname(fileURLToPath(import.meta.url));
const NEW_SESSION_CLI = path.join(SRC, 'new-session.mjs');

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeRepo(prefix) {
  const root = tmp(prefix);
  initRepo(root, true);
  return root;
}

/** Initialise a git repo at `dir`; with `commit` false, HEAD stays unborn. */
function initRepo(dir, commit) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  if (commit) {
    fs.writeFileSync(path.join(dir, 'README.md'), `${path.basename(dir)}\n`, 'utf8');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
  }
}

function runNewSession(cwd, args) {
  return spawnSync(process.execPath, [NEW_SESSION_CLI, ...args], { cwd, encoding: 'utf8' });
}

function readSessionJson(root, sessionId) {
  return JSON.parse(
    fs.readFileSync(path.join(root, '.forge', 'sessions', sessionId, 'session.json'), 'utf8'),
  );
}

function newSession(root) {
  const r = runNewSession(root, ['nested-fixture']);
  assert.equal(r.status, 0, r.stderr);
  const { sessionId } = JSON.parse(r.stdout);
  return readSessionJson(root, sessionId);
}

test('forge new: records the HEAD of a nested repo keyed by relative path', () => {
  const root = makeRepo('new-session-nested-');
  initRepo(path.join(root, 'volo_web'), true);
  const session = newSession(root);
  assert.deepEqual(session.nestedBaseCommits, {
    volo_web: git(path.join(root, 'volo_web'), 'rev-parse', 'HEAD'),
  });
  // The nested HEAD must differ from the outer one, or the key proves nothing.
  assert.notEqual(session.nestedBaseCommits.volo_web, session.baseCommit);
});

test('forge new: records a repo two levels deep under a posix key; ignores three levels', () => {
  const root = makeRepo('new-session-nested-depth-');
  initRepo(path.join(root, 'a', 'b'), true);
  initRepo(path.join(root, 'a', 'b', 'c'), true);
  initRepo(path.join(root, 'x', 'y', 'z'), true);
  const session = newSession(root);
  assert.deepEqual(session.nestedBaseCommits, {
    'a/b': git(path.join(root, 'a', 'b'), 'rev-parse', 'HEAD'),
  });
});

test('forge new: skips node_modules and dot-directories', () => {
  const root = makeRepo('new-session-nested-skip-');
  initRepo(path.join(root, 'node_modules', 'x'), true);
  initRepo(path.join(root, '.hidden', 'y'), true);
  initRepo(path.join(root, 'real'), true);
  const session = newSession(root);
  assert.deepEqual(Object.keys(session.nestedBaseCommits), ['real']);
});

test('forge new: omits a nested repo whose HEAD cannot be read (no commits)', () => {
  const root = makeRepo('new-session-nested-unborn-');
  initRepo(path.join(root, 'empty'), false);
  initRepo(path.join(root, 'ok'), true);
  const session = newSession(root);
  assert.deepEqual(session.nestedBaseCommits, {
    ok: git(path.join(root, 'ok'), 'rev-parse', 'HEAD'),
  });
});

test('forge new: nestedBaseCommits is absent when there are no nested repos', () => {
  const root = makeRepo('new-session-nested-none-');
  fs.mkdirSync(path.join(root, 'plain', 'dir'), { recursive: true });
  const session = newSession(root);
  assert.equal('nestedBaseCommits' in session, false);
});

test('forge status: shows nestedBaseCommits when present', () => {
  const root = makeRepo('new-session-nested-status-');
  initRepo(path.join(root, 'volo_web'), true);
  newSession(root);
  const r = spawnSync(process.execPath, [path.join(SRC, 'session-status.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.session.nestedBaseCommits, {
    volo_web: git(path.join(root, 'volo_web'), 'rev-parse', 'HEAD'),
  });
});
