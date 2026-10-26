import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { escapeCandidates, pendingCandidates } from './escapes.mjs';

/**
 * `forge escapes` searches the root range and each nested repository's range,
 * the same blame logic with cwd = that repository. Candidates name their repo.
 */

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'escapes-cli.mjs');
const DAY = 86400000;
const T0 = Date.parse('2026-10-01T12:00:00Z');
const OLD = 'old1\nold2\nold3\n';
const ADDED = 'add1\nadd2\nadd3\nadd4\n';

/** A git repo at `dir` whose commits carry controlled dates. */
function repoAt(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (args, at = T0) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: new Date(at).toISOString(), GIT_COMMITTER_DATE: new Date(at).toISOString() },
    }).trim();
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  const commit = (files, subject, at) => {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    git(['add', '-A'], at);
    git(['commit', '-qm', subject], at);
    return git(['rev-parse', 'HEAD']);
  };
  return { dir, git, commit };
}

/**
 * A root repo (plan engine `specs`) holding its own change, plus nested repo
 * `volo_web` where the change added ADDED to `src/a.js`, `specs/n.md` and
 * `.forge/n.md`. The nested repo is created after the root's last commit, so
 * the root never stages it.
 */
function fixture() {
  const root = repoAt(fs.mkdtempSync(path.join(tmpdir(), 'forge-escapes-nested-')));
  fs.mkdirSync(path.join(root.dir, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(root.dir, '.forge', 'config.json'), '{"plan":{"engine":"specs","dir":"specs"}}\n');
  const rootBase = root.commit({ 'src/r.js': OLD }, 'base', T0 - DAY);
  const rootHead = root.commit({ 'src/r.js': OLD + ADDED }, 'feat: root change', T0);

  const nested = repoAt(path.join(root.dir, 'volo_web'));
  const base = nested.commit({ 'src/a.js': OLD }, 'base', T0 - DAY);
  const head = nested.commit(
    { 'src/a.js': OLD + ADDED, 'specs/n.md': OLD + ADDED, '.forge/n.md': OLD + ADDED },
    'feat: nested change',
    T0,
  );
  const session = {
    sessionId: 's1',
    slug: 'c',
    doneAt: new Date(T0 + 3600000).toISOString(),
    commitRange: { base: rootBase, head: rootHead },
    nestedCommitRanges: { volo_web: { base, head } },
  };
  return { root, nested, session, rootBase, rootHead, base, head };
}

const rewrite = (text) => text.replace('add1', 'add1-fixed');

test('a later nested commit rewriting a line the change added is listed with its repo', () => {
  const f = fixture();
  const fix = f.nested.commit({ 'src/a.js': rewrite(OLD + ADDED) }, 'fix: nested add1', T0 + DAY);
  const result = escapeCandidates({ cwd: f.root.dir, session: f.session });
  assert.deepEqual(result.candidates.map((c) => [c.commit, c.repo, c.files]), [[fix, 'volo_web', ['src/a.js']]]);
  assert.equal(result.candidates[0].lines, 1);
  assert.equal(result.skipped, null);
});

test('a root candidate names the root repository', () => {
  const f = fixture();
  const rootFix = f.root.commit({ 'src/r.js': rewrite(OLD + ADDED) }, 'fix: root add1', T0 + DAY);
  const nestedFix = f.nested.commit({ 'src/a.js': rewrite(OLD + ADDED) }, 'fix: nested add1', T0 + DAY);
  const result = escapeCandidates({ cwd: f.root.dir, session: f.session });
  const byCommit = Object.fromEntries(result.candidates.map((c) => [c.commit, c.repo]));
  assert.deepEqual(byCommit, { [rootFix]: '.', [nestedFix]: 'volo_web' });
});

test('an unrelated or late nested commit is not a candidate', () => {
  const f = fixture();
  f.nested.commit({ 'src/a.js': OLD.replace('old2', 'old2-edited') + ADDED }, 'tweak old2', T0 + DAY);
  f.nested.commit({ 'src/a.js': OLD.replace('old2', 'old2-edited') + rewrite(ADDED) }, 'late fix', T0 + 20 * DAY);
  assert.deepEqual(escapeCandidates({ cwd: f.root.dir, session: f.session }).candidates, []);
});

test('the plan-dir and .forge/ ignore rules apply to the root repo only', () => {
  const f = fixture();
  const fix = f.nested.commit(
    { 'specs/n.md': rewrite(OLD + ADDED), '.forge/n.md': rewrite(OLD + ADDED) },
    'fix: nested docs',
    T0 + DAY,
  );
  const result = escapeCandidates({ cwd: f.root.dir, session: f.session });
  assert.deepEqual(result.candidates.map((c) => [c.commit, c.repo, c.files.slice().sort()]), [[fix, 'volo_web', ['.forge/n.md', 'specs/n.md']]]);
  // The same rewrite in the root repo is ignored.
  f.root.commit({ 'specs/changes/c/p.md': OLD + ADDED }, 'plan', T0 - 3600000);
  const rootSession = { ...f.session, commitRange: { base: f.rootBase, head: f.root.git(['rev-parse', 'HEAD']) }, nestedCommitRanges: {} };
  f.root.commit({ 'specs/changes/c/p.md': rewrite(OLD + ADDED) }, 'fix: plan', T0 + DAY);
  assert.deepEqual(escapeCandidates({ cwd: f.root.dir, session: rootSession }).candidates, []);
});

test('a session with only nested ranges is searched, not skipped', () => {
  const f = fixture();
  const fix = f.nested.commit({ 'src/a.js': rewrite(OLD + ADDED) }, 'fix: nested add1', T0 + DAY);
  const session = { ...f.session, commitRange: null, slug: null };
  const result = escapeCandidates({ cwd: f.root.dir, session });
  assert.equal(result.skipped, null);
  assert.deepEqual(result.candidates.map((c) => [c.commit, c.repo]), [[fix, 'volo_web']]);
});

test('a nested range whose head is not on the repository HEAD is skipped with a reason', () => {
  const f = fixture();
  f.nested.git(['checkout', '-q', '-b', 'side', f.base]);
  const session = { ...f.session, commitRange: null, slug: null };
  const result = escapeCandidates({ cwd: f.root.dir, session });
  assert.deepEqual(result.candidates, []);
  assert.match(result.skipped ?? '', /volo_web/);
  assert.match(result.skipped ?? '', /not on HEAD/);
});

test('pendingCandidates and `forge escapes list` show the repository', () => {
  const f = fixture();
  const fix = f.nested.commit({ 'src/a.js': rewrite(OLD + ADDED) }, 'fix: nested add1', T0 + DAY);
  const row = { sessionId: 's1', slug: 'c', phase: 'done', endedAt: f.session.doneAt, commitRange: f.session.commitRange, nestedCommitRanges: f.session.nestedCommitRanges };
  fs.writeFileSync(path.join(f.root.dir, '.forge', 'sessions.jsonl'), `${JSON.stringify(row)}\n`);
  const fleet = fs.mkdtempSync(path.join(tmpdir(), 'forge-escapes-nested-fleet-'));
  const prev = process.env.FORGEKIT_FLEET_DIR;
  process.env.FORGEKIT_FLEET_DIR = fleet;
  try {
    const sessions = pendingCandidates({ cwd: f.root.dir });
    assert.deepEqual(sessions.flatMap((s) => s.candidates.map((c) => [c.commit, c.repo])), [[fix, 'volo_web']]);
  } finally {
    if (prev === undefined) delete process.env.FORGEKIT_FLEET_DIR;
    else process.env.FORGEKIT_FLEET_DIR = prev;
  }
  const r = spawnSync(process.execPath, [CLI, 'list'], { cwd: f.root.dir, encoding: 'utf8', env: { ...process.env, FORGEKIT_FLEET_DIR: fleet } });
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.includes(fix.slice(0, 7)));
  assert.ok(line, r.stdout);
  assert.match(line, /volo_web/);
});
