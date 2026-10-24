import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { doneSessions, escapeCandidates, inferCommitRange } from './escapes.mjs';

const DAY = 86400000;
const T0 = Date.parse('2026-10-01T12:00:00Z');

/** A scratch repo whose commits carry controlled dates. */
function repo() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'forge-escapes-'));
  const git = (args, at = T0) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: new Date(at).toISOString(), GIT_COMMITTER_DATE: new Date(at).toISOString() },
    }).trim();
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge', 'config.json'), '{"plan":{"engine":"specs","dir":"specs"}}\n');
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  /** Write files and commit them at `at`; returns the sha. */
  const commit = (files, subject, at) => {
    for (const [rel, text] of Object.entries(files)) {
      if (text === null) fs.rmSync(path.join(dir, rel));
      else write(rel, text);
    }
    git(['add', '-A'], at);
    git(['commit', '-qm', subject], at);
    return git(['rev-parse', 'HEAD']);
  };
  return { dir, git, commit };
}

const OLD = 'old1\nold2\nold3\n';
const ADDED = 'add1\nadd2\nadd3\nadd4\n';

/** base → change commit (adds add1..add4 + a plan file) → done at T0 + 1h. */
function withChange() {
  const r = repo();
  const base = r.commit({ 'src/a.js': OLD }, 'base', T0 - DAY);
  const head = r.commit({ 'src/a.js': OLD + ADDED, 'specs/changes/c/tasks.md': 'one\n' }, 'feat: change', T0);
  const session = {
    sessionId: 's1',
    slug: 'c',
    doneAt: new Date(T0 + 3600000).toISOString(),
    commitRange: { base, head },
  };
  return { ...r, base, head, session };
}

const shas = (result) => result.candidates.map((c) => c.commit);

test('a later commit rewriting a change line is a candidate', () => {
  const r = withChange();
  const fix = r.commit({ 'src/a.js': OLD + ADDED.replace('add1', 'add1-fixed') }, 'fix: add1', T0 + DAY);
  const result = escapeCandidates({ cwd: r.dir, session: r.session });
  assert.deepEqual(shas(result), [fix]);
  assert.equal(result.candidates[0].lines, 1);
  assert.deepEqual(result.candidates[0].files, ['src/a.js']);
  assert.equal(result.candidates[0].subject, 'fix: add1');
});

test('a commit deleting a change line is a candidate', () => {
  const r = withChange();
  const del = r.commit({ 'src/a.js': OLD + ADDED.replace('add2\n', '') }, 'remove add2', T0 + DAY);
  assert.deepEqual(shas(escapeCandidates({ cwd: r.dir, session: r.session })), [del]);
});

test('a commit touching only lines the change did not add is not a candidate', () => {
  const r = withChange();
  r.commit({ 'src/a.js': OLD.replace('old2', 'old2-edited') + ADDED }, 'tweak old2', T0 + DAY);
  r.commit({ 'src/a.js': OLD.replace('old2', 'old2-edited') + ADDED + 'appended\n' }, 'append', T0 + DAY);
  assert.deepEqual(shas(escapeCandidates({ cwd: r.dir, session: r.session })), []);
});

test('a commit more than 14 days after done is not a candidate', () => {
  const r = withChange();
  r.commit({ 'src/a.js': OLD + ADDED.replace('add3', 'add3-late') }, 'late fix', T0 + 20 * DAY);
  assert.deepEqual(shas(escapeCandidates({ cwd: r.dir, session: r.session })), []);
});

test('same-session commits are skipped: the range itself and forge(<slug>) subjects', () => {
  const r = withChange();
  r.commit({ 'src/a.js': OLD + ADDED.replace('add4', 'add4-ckpt') }, 'forge(c): archive — c', T0 + DAY);
  assert.deepEqual(shas(escapeCandidates({ cwd: r.dir, session: r.session })), []);
});

test('edits to plan-engine files are not code and are ignored', () => {
  const r = withChange();
  r.commit({ 'specs/changes/c/tasks.md': 'one-edited\n' }, 'specs: edit', T0 + DAY);
  r.commit({ 'specs/changes/c/tasks.md': null }, 'specs: archive c', T0 + DAY);
  assert.deepEqual(shas(escapeCandidates({ cwd: r.dir, session: r.session })), []);
});

test('a renamed file still traces its change lines', () => {
  const r = withChange();
  r.git(['mv', 'src/a.js', 'src/b.js'], T0 + DAY);
  r.git(['commit', '-qm', 'rename'], T0 + DAY);
  const fix = r.commit({ 'src/b.js': OLD + ADDED.replace('add1', 'add1-fixed') }, 'fix after rename', T0 + 2 * DAY);
  assert.deepEqual(shas(escapeCandidates({ cwd: r.dir, session: r.session })), [fix]);
});

test('a head that is not on the scanned ref is skipped with a reason', () => {
  const r = withChange();
  r.git(['checkout', '-q', '-b', 'side', r.base]);
  const result = escapeCandidates({ cwd: r.dir, session: r.session, rev: 'HEAD' });
  assert.deepEqual(result.candidates, []);
  assert.match(result.skipped ?? '', /not on HEAD/);
});

test('a range is inferred from forge(<slug>) commits when none was recorded', () => {
  const r = repo();
  const base = r.commit({ 'src/a.js': OLD }, 'base', T0 - DAY);
  r.commit({ 'src/a.js': OLD + 'add1\n' }, 'forge(c): checkpoint — 01-one tasks 1.1', T0 - 3600000);
  const head = r.commit({ 'src/a.js': OLD + 'add1\nadd2\n' }, 'forge(c): checkpoint — 02-two tasks 2.1', T0);
  r.commit({ 'src/other.js': 'x\n' }, 'forge(other): checkpoint — 01', T0 + DAY / 2);
  assert.deepEqual(inferCommitRange({ cwd: r.dir, slug: 'c' }), { base, head });
  const fix = r.commit({ 'src/a.js': OLD + 'add1-fixed\nadd2\n' }, 'fix add1', T0 + DAY);
  const result = escapeCandidates({ cwd: r.dir, session: { sessionId: 's', slug: 'c', doneAt: new Date(T0).toISOString() } });
  assert.equal(result.inferred, true);
  assert.deepEqual(shas(result), [fix]);
  assert.equal(inferCommitRange({ cwd: r.dir, slug: 'nothing-here' }), null);
});

test('doneSessions merges the digest ledger with this repo\'s fleet entries, deduped', () => {
  const r = withChange();
  const rows = [
    { sessionId: 'd1', slug: 'one', phase: 'done', endedAt: '2026-10-01T00:00:00.000Z', commitRange: { base: r.base, head: r.head } },
    { sessionId: 'd2', slug: 'two', phase: 'skipped', endedAt: '2026-10-02T00:00:00.000Z' },
  ];
  fs.writeFileSync(path.join(r.dir, '.forge', 'sessions.jsonl'), `${rows.map((x) => JSON.stringify(x)).join('\n')}\n`);
  const fleet = fs.mkdtempSync(path.join(tmpdir(), 'forge-escapes-fleet-'));
  const entry = (id, project, extra) =>
    fs.writeFileSync(
      path.join(fleet, `${id}.json`),
      JSON.stringify({ project, projectName: path.basename(project), sessionId: id, slug: id, phase: 'done', updatedAt: '2026-10-03T00:00:00.000Z', ...extra }),
    );
  entry('d1', r.dir, {}); // same session as the digest row — digest wins
  entry('w1', path.join(path.dirname(r.dir), 'gone-worktree'), { projectName: path.basename(r.dir), commitRange: { base: r.base, head: r.head } });
  entry('x1', path.join(tmpdir(), 'some-other-project'), {});
  entry('p1', r.dir, { phase: 'implement' });
  const prev = process.env.FORGEKIT_FLEET_DIR;
  process.env.FORGEKIT_FLEET_DIR = fleet;
  try {
    const sessions = doneSessions({ cwd: r.dir });
    assert.deepEqual(sessions.map((s) => s.sessionId).sort(), ['d1', 'w1']);
    const d1 = sessions.find((s) => s.sessionId === 'd1');
    assert.equal(d1.doneAt, '2026-10-01T00:00:00.000Z', 'digest endedAt wins over the registry updatedAt');
    assert.equal(sessions.find((s) => s.sessionId === 'w1').doneAt, '2026-10-03T00:00:00.000Z');
  } finally {
    if (prev === undefined) delete process.env.FORGEKIT_FLEET_DIR;
    else process.env.FORGEKIT_FLEET_DIR = prev;
  }
});
