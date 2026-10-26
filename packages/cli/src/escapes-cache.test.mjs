import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { escapeCandidates, escapeCacheStats } from './escapes.mjs';

/**
 * F29: on Volo the search took ~66 s per session because every session re-ran `git diff` and
 * `git blame` on the same later commits. Those results depend only on (repository, commit), so
 * they are computed once per run; only the "is this line one of the session's commits" filter is
 * per session.
 */

const DAY = 86400000;
const T0 = Date.parse('2026-10-01T12:00:00Z');

function repo() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'forge-escapes-cache-'));
  const git = (args, at = T0) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: new Date(at).toISOString(), GIT_COMMITTER_DATE: new Date(at).toISOString() },
    }).trim();
  git(['init', '-q']);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['core.autocrlf', 'false']]) git(['config', k, v]);
  const commit = (files, subject, at) => {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    git(['add', '-A'], at);
    git(['commit', '-qm', subject], at);
    return git(['rev-parse', 'HEAD']);
  };
  return { dir, commit };
}

test('two sessions sharing later commits blame each later commit once, with identical results', () => {
  const r = repo();
  const base = r.commit({ 'a.js': 'x\n', 'b.js': 'y\n' }, 'base', T0 - DAY);
  const a = r.commit({ 'a.js': 'x\nA1\nA2\n' }, 'feat: a', T0);
  const b = r.commit({ 'b.js': 'y\nB1\nB2\n' }, 'feat: b', T0 + 60000);
  r.commit({ 'a.js': 'x\nA1-fixed\nA2\n', 'b.js': 'y\nB1-fixed\nB2\n' }, 'fix: both', T0 + DAY);
  const sessA = { sessionId: 'sa', slug: 'a', doneAt: new Date(T0 + 1000).toISOString(), commitRange: { base, head: a } };
  const sessB = { sessionId: 'sb', slug: 'b', doneAt: new Date(T0 + 61000).toISOString(), commitRange: { base: a, head: b } };

  const before = escapeCacheStats();
  const ra = escapeCandidates({ cwd: r.dir, session: sessA });
  const mid = escapeCacheStats();
  const rb = escapeCandidates({ cwd: r.dir, session: sessB });
  const after = escapeCacheStats();

  assert.equal(ra.candidates.length, 1, JSON.stringify(ra));
  assert.equal(rb.candidates.length, 1, JSON.stringify(rb));
  assert.equal(ra.candidates[0].commit, rb.candidates[0].commit, 'the same fix is a candidate for both');
  assert.ok(mid.changed.misses > before.changed.misses, 'the first session listed the fix commit');
  assert.equal(after.changed.misses, mid.changed.misses, 'the second session did not list the shared commit again');
  assert.ok(after.changed.hits > mid.changed.hits, 'it reused the listing');

  // A session over the same files reuses the diff and blame too.
  const sessA2 = { ...sessA, sessionId: 'sa2' };
  const s0 = escapeCacheStats();
  const ra2 = escapeCandidates({ cwd: r.dir, session: sessA2 });
  const s1 = escapeCacheStats();
  assert.deepEqual(ra2.candidates, ra.candidates);
  assert.equal(s1.ranges.misses, s0.ranges.misses, 'no new diff');
  assert.equal(s1.blame.misses, s0.blame.misses, 'no new blame');
  assert.ok(s1.blame.hits > s0.blame.hits);

  // A second pass over the same session gives the same answer from the cache.
  const again = escapeCandidates({ cwd: r.dir, session: sessA });
  assert.deepEqual(again, ra);
});
