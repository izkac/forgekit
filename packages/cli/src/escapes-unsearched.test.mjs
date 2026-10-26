import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { escapeCandidates, escapeReport } from './escapes.mjs';

/**
 * A recorded range that cannot be searched (repo gone, head off the scanned
 * ref) must stay visible even when another range of the session was searched.
 */

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'escapes-cli.mjs');
const DAY = 86400000;
const T0 = Date.parse('2026-10-01T12:00:00Z');
const OLD = 'old1\nold2\nold3\n';
const ADDED = 'add1\nadd2\nadd3\nadd4\n';
const rewrite = (text) => text.replace('add1', 'add1-fixed');

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

/** A searchable root range, a nested repo `web` whose recorded head is on a side branch, and a `gone` range. */
function fixture() {
  const root = repoAt(fs.mkdtempSync(path.join(tmpdir(), 'forge-escapes-unsearched-')));
  fs.mkdirSync(path.join(root.dir, '.forge'), { recursive: true });
  const rootBase = root.commit({ 'src/r.js': OLD }, 'base', T0 - DAY);
  const rootHead = root.commit({ 'src/r.js': OLD + ADDED }, 'feat: root change', T0);
  const rootFix = root.commit({ 'src/r.js': rewrite(OLD + ADDED) }, 'fix: root add1', T0 + DAY);

  const web = repoAt(path.join(root.dir, 'web'));
  const base = web.commit({ 'a.js': OLD }, 'base', T0 - DAY);
  web.git(['checkout', '-q', '-b', 'side']);
  const head = web.commit({ 'a.js': OLD + ADDED }, 'feat: web change', T0);
  web.git(['checkout', '-q', '-']);
  const session = {
    sessionId: 's1',
    slug: 'c',
    doneAt: new Date(T0 + 3600000).toISOString(),
    commitRange: { base: rootBase, head: rootHead },
    nestedCommitRanges: { web: { base, head }, gone: { base, head } },
  };
  const fleet = fs.mkdtempSync(path.join(tmpdir(), 'forge-escapes-unsearched-fleet-'));
  const row = { sessionId: 's1', slug: 'c', phase: 'done', endedAt: session.doneAt, commitRange: session.commitRange, nestedCommitRanges: session.nestedCommitRanges };
  fs.writeFileSync(path.join(root.dir, '.forge', 'sessions.jsonl'), `${JSON.stringify(row)}\n`);
  return { root, session, rootFix, base, head, fleet };
}

const cli = (f, ...args) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd: f.root.dir, encoding: 'utf8', env: { ...process.env, FORGEKIT_FLEET_DIR: f.fleet } });

test('root candidates are still listed and each unsearchable nested range is reported', () => {
  const f = fixture();
  const result = escapeCandidates({ cwd: f.root.dir, session: f.session });
  assert.deepEqual(result.candidates.map((c) => [c.commit, c.repo]), [[f.rootFix, '.']]);
  assert.equal(result.skipped, null, 'something was searched, so the session is not skipped');
  assert.equal(result.unsearched.length, 2);
  const web = result.unsearched.find((r) => r.startsWith('web:'));
  assert.ok(web?.includes(f.head.slice(0, 7)) && /not on HEAD/.test(web), web);
  assert.ok(result.unsearched.some((r) => r.startsWith('gone:') && /gone/.test(r)));
});

test('a session whose every range is searchable has no unsearched ranges', () => {
  const f = fixture();
  const session = { ...f.session, nestedCommitRanges: {} };
  assert.deepEqual(escapeCandidates({ cwd: f.root.dir, session }).unsearched, []);
});

test('when nothing could be searched, skipped still carries the reasons', () => {
  const f = fixture();
  const session = { ...f.session, commitRange: null, slug: null };
  const result = escapeCandidates({ cwd: f.root.dir, session });
  assert.match(result.skipped ?? '', /web: head/);
  assert.equal(result.unsearched.length, 2);
});

test('forge escapes list prints one line per unsearched repository', () => {
  const f = fixture();
  const r = cli(f, 'list');
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n').filter((l) => /unsearched/.test(l));
  assert.equal(lines.length, 2, r.stdout);
  assert.ok(lines.some((l) => l.includes(`web: head ${f.head.slice(0, 7)} not on HEAD`)));
  assert.ok(r.stdout.includes(f.rootFix.slice(0, 7)), 'the searchable root candidate is still listed');
});

test('forge escapes verify reports the unsearched ranges in its summary', () => {
  const f = fixture();
  const r = cli(f, 'verify', '--all', '--json');
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.summary.unsearched, 2);
  assert.deepEqual(doc.results.map((x) => x.commit), [f.rootFix]);
  const text = cli(f, 'verify', '--all');
  assert.match(text.stdout, /unsearched/);
});

test('forge escapes report counts sessions with unsearched ranges', () => {
  const f = fixture();
  const prev = process.env.FORGEKIT_FLEET_DIR;
  process.env.FORGEKIT_FLEET_DIR = f.fleet;
  try {
    assert.equal(escapeReport({ cwd: f.root.dir }).unsearched.sessions, 1);
  } finally {
    if (prev === undefined) delete process.env.FORGEKIT_FLEET_DIR;
    else process.env.FORGEKIT_FLEET_DIR = prev;
  }
  const r = cli(f, 'report');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 session\(s\) with unsearched ranges/);
});
