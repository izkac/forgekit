import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { decide, escapeCandidates } from './escapes.mjs';

// Regressions from the final review: I1 (hunk/path parsing), I2 (merged-in
// commits, rebased heads), M5 (replay test must be a file in the repo).

const DAY = 86400000;
const T0 = Date.parse('2026-10-01T12:00:00Z');

function repo(gitConfig = []) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'forge-escapes-fix-'));
  const git = (args, at = T0) =>
    execFileSync('git', [...gitConfig, ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: new Date(at).toISOString(), GIT_COMMITTER_DATE: new Date(at).toISOString() },
    }).trim();
  git(['init', '-q', '-b', 'main']);
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

const done = new Date(T0 + 3600000).toISOString();
const shas = (r) => r.candidates.map((c) => c.commit);

test('I1: a path with a space still yields its candidate', () => {
  const r = repo();
  const base = r.commit({ 'src/my file.js': 'old\n' }, 'base', T0 - DAY);
  const head = r.commit({ 'src/my file.js': 'old\nadd1\n' }, 'feat', T0);
  const fix = r.commit({ 'src/my file.js': 'old\nadd1-fixed\n' }, 'fix', T0 + DAY);
  const res = escapeCandidates({ cwd: r.dir, session: { sessionId: 's', slug: 'x', doneAt: done, commitRange: { base, head } } });
  assert.deepEqual(shas(res), [fix]);
});

test('I1: a removed line starting with "-- " does not hide later hunks', () => {
  const r = repo();
  const base = r.commit({ 'db/q.sql': '-- header\nselect 1;\nkeep\n' }, 'base', T0 - DAY);
  const head = r.commit({ 'db/q.sql': '-- header\nselect 1;\nkeep\na1\n' }, 'feat', T0);
  const fix = r.commit({ 'db/q.sql': 'select 1;\nkeep\na1-fixed\n' }, 'fix', T0 + DAY);
  const res = escapeCandidates({ cwd: r.dir, session: { sessionId: 's', slug: 'x', doneAt: done, commitRange: { base, head } } });
  assert.deepEqual(shas(res), [fix]);
  assert.equal(res.candidates[0].lines, 1, 'only a1 is a change line; the header was pre-existing');
});

test('I1: diff.noprefix in the user config does not break parsing', () => {
  const r = repo();
  const base = r.commit({ 'src/a.js': 'old\n' }, 'base', T0 - DAY);
  const head = r.commit({ 'src/a.js': 'old\nadd1\n' }, 'feat', T0);
  const fix = r.commit({ 'src/a.js': 'old\nadd1-fixed\n' }, 'fix', T0 + DAY);
  r.git(['config', 'diff.noprefix', 'true']);
  const res = escapeCandidates({ cwd: r.dir, session: { sessionId: 's', slug: 'x', doneAt: done, commitRange: { base, head } } });
  assert.deepEqual(shas(res), [fix]);
});

test('I2: lines merged in from main are not the change\'s lines', () => {
  const r = repo();
  const base = r.commit({ 'src/ours.js': 'o\n', 'src/theirs.js': 't\n' }, 'base', T0 - 2 * DAY);
  r.git(['checkout', '-q', '-b', 'feat'], T0 - 2 * DAY);
  r.commit({ 'src/ours.js': 'o\nours1\n' }, 'feat: ours', T0 - DAY);
  r.git(['checkout', '-q', 'main']);
  r.commit({ 'src/theirs.js': 't\ntheirs1\n' }, 'other session: theirs', T0 - DAY);
  r.git(['checkout', '-q', 'feat']);
  r.git(['merge', '-q', '--no-edit', 'main'], T0);
  const head = r.git(['rev-parse', 'HEAD']);
  r.git(['checkout', '-q', 'main']);
  r.git(['merge', '-q', '--no-edit', 'feat'], T0);
  const otherFix = r.commit({ 'src/theirs.js': 't\ntheirs1-fixed\n' }, 'fix: other session bug', T0 + DAY);
  const ourFix = r.commit({ 'src/ours.js': 'o\nours1-fixed\n' }, 'fix: ours', T0 + DAY);
  const res = escapeCandidates({ cwd: r.dir, session: { sessionId: 's', slug: 'x', doneAt: done, commitRange: { base, head } } });
  assert.ok(!shas(res).includes(otherFix), 'another session\'s line is not this change\'s Escape');
  assert.deepEqual(shas(res), [ourFix]);
});

test('I2: a rebased head falls back to the range inferred from forge(<slug>) commits', () => {
  const r = repo();
  r.commit({ 'src/a.js': 'old\n' }, 'base', T0 - 2 * DAY);
  r.git(['checkout', '-q', '-b', 'feat']);
  const oldHead = r.commit({ 'src/a.js': 'old\nadd1\n' }, 'forge(x): checkpoint — 01', T0 - DAY);
  r.git(['checkout', '-q', 'main']);
  r.commit({ 'src/other.js': 'z\n' }, 'unrelated on main', T0 - DAY);
  r.git(['checkout', '-q', 'feat']);
  r.git(['rebase', '-q', 'main'], T0);
  r.git(['checkout', '-q', 'main']);
  r.git(['merge', '-q', '--ff-only', 'feat'], T0);
  const fix = r.commit({ 'src/a.js': 'old\nadd1-fixed\n' }, 'fix add1', T0 + DAY);
  const res = escapeCandidates({
    cwd: r.dir,
    session: { sessionId: 's', slug: 'x', doneAt: done, commitRange: { base: 'deadbeef', head: oldHead } },
  });
  assert.equal(res.skipped, null, res.skipped);
  assert.equal(res.inferred, true);
  assert.deepEqual(shas(res), [fix]);
});

test('M5: a replay test must be a file inside the repository', () => {
  const r = repo();
  const c = r.commit({ 'src/a.js': '1\n' }, 'fix', T0);
  fs.mkdirSync(path.join(r.dir, 'test'), { recursive: true });
  assert.equal(decide({ cwd: r.dir, sessionId: 's', commit: c, decision: 'confirmed', replayTest: 'test' }).ok, false, 'a directory is not a test');
  const outside = path.join(fs.mkdtempSync(path.join(tmpdir(), 'forge-outside-')), 'x.test.js');
  fs.writeFileSync(outside, 'x\n');
  assert.equal(decide({ cwd: r.dir, sessionId: 's', commit: c, decision: 'confirmed', replayTest: outside }).ok, false, 'outside the repo');
});
