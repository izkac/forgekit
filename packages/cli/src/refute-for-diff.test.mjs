import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addRefutation, changedBasenames, listRefutationsForDiff, parseArgs, renderKnownFalseMd } from './refute.mjs';

const FORGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'forge.mjs');
const SESSION = 's-current';
const NOW = () => new Date('2026-10-25T12:00:00.000Z');

/** A project with this session's ledger plus a carried `.forge/known-false.jsonl`. */
function project(carried) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'forge-refute-diff-'));
  const forgeDir = path.join(root, '.forge');
  const sessionDir = path.join(forgeDir, 'sessions', SESSION);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(forgeDir, 'known-false.jsonl'), carried.map((c) => `${JSON.stringify(c)}\n`).join(''));
  return { root, forgeDir, sessionDir };
}

/** A carried ledger entry; `n` orders `at` (larger n = more recent). */
function carried(n, fields = {}) {
  return {
    sessionId: `old-${n}`,
    change: `change-${n}`,
    id: `KF${n}`,
    task: '1.1',
    claim: `claim ${n}`,
    actual: `actual ${n}`,
    source: 'reviewer',
    at: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
    ...fields,
  };
}

test('a carried entry whose claim or actual mentions a changed basename is included; others are not', () => {
  const p = project([
    carried(1, { claim: 'seal.mjs retries three times' }),
    carried(2, { actual: 'the LEDGER.MJS digest drops fields' }),
    carried(3, { claim: 'unrelated', actual: 'also unrelated' }),
  ]);
  const got = listRefutationsForDiff(p.sessionDir, { forgeDir: p.forgeDir, basenames: ['seal.mjs', 'ledger.mjs'] });
  assert.deepEqual(got.map((r) => r.id).sort(), ['KF1', 'KF2']);
  const none = listRefutationsForDiff(p.sessionDir, { forgeDir: p.forgeDir, basenames: ['other.mjs'] });
  assert.deepEqual(none, []);
});

test('an empty basename matches nothing (it would otherwise match every entry)', () => {
  const p = project([carried(1, { claim: 'anything at all' })]);
  assert.deepEqual(listRefutationsForDiff(p.sessionDir, { forgeDir: p.forgeDir, basenames: [''] }), []);
});

test("this session's refutations are always included, even when no basename matches", () => {
  const p = project([carried(1, { claim: 'seal.mjs thing' })]);
  addRefutation(p.sessionDir, { task: '2.1', claim: 'nothing file related', actual: 'x' }, NOW);
  addRefutation(p.sessionDir, { task: '2.2', claim: 'still nothing', actual: 'y' }, NOW);
  const got = listRefutationsForDiff(p.sessionDir, { forgeDir: p.forgeDir, basenames: ['seal.mjs'] });
  assert.deepEqual(
    got.map((r) => r.claim),
    ['nothing file related', 'still nothing', 'seal.mjs thing'],
  );
  const noDiff = listRefutationsForDiff(p.sessionDir, { forgeDir: p.forgeDir, basenames: [] });
  assert.equal(noDiff.length, 2);
});

test('a carried entry from this very session is not added a second time', () => {
  const p = project([carried(1, { sessionId: SESSION, claim: 'seal.mjs dup' })]);
  addRefutation(p.sessionDir, { task: '2.1', claim: 'local seal.mjs', actual: 'x' }, NOW);
  const got = listRefutationsForDiff(p.sessionDir, { forgeDir: p.forgeDir, basenames: ['seal.mjs'] });
  assert.deepEqual(got.map((r) => r.claim), ['local seal.mjs']);
});

test('carried matches are capped at 20, keeping the most recent first', () => {
  const total = 27;
  // Written oldest-first AND scrambled so file order cannot stand in for recency.
  const entries = Array.from({ length: total }, (_, i) => carried(i + 1, { claim: `seal.mjs case ${i + 1}` }));
  const scrambled = [...entries.filter((_, i) => i % 2 === 0), ...entries.filter((_, i) => i % 2 === 1)];
  const p = project(scrambled);
  const got = listRefutationsForDiff(p.sessionDir, { forgeDir: p.forgeDir, basenames: ['seal.mjs'] });
  const expected = [...entries].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20);
  assert.equal(got.length, 20);
  assert.deepEqual(got.map((r) => r.id), expected.map((r) => r.id));
  assert.ok(!got.some((r) => r.id === 'KF1'), 'the oldest match was cut');
});

test('the cap does not apply to this session, only to carried matches', () => {
  const entries = Array.from({ length: 22 }, (_, i) => carried(i + 1, { claim: `seal.mjs case ${i + 1}` }));
  const p = project(entries);
  for (let i = 0; i < 23; i += 1) addRefutation(p.sessionDir, { task: '1.1', claim: `local ${i}`, actual: 'x' }, NOW);
  const got = listRefutationsForDiff(p.sessionDir, { forgeDir: p.forgeDir, basenames: ['seal.mjs'] });
  assert.equal(got.length, 23 + 20);
  assert.deepEqual(got.slice(0, 23).map((r) => r.claim), Array.from({ length: 23 }, (_, i) => `local ${i}`));
});

test('an entry without an `at` sorts as oldest rather than throwing', () => {
  const noAt = carried(1, { claim: 'seal.mjs undated' });
  delete noAt.at;
  const p = project([noAt, carried(2, { claim: 'seal.mjs dated' })]);
  const got = listRefutationsForDiff(p.sessionDir, { forgeDir: p.forgeDir, basenames: ['seal.mjs'] });
  assert.deepEqual(got.map((r) => r.claim), ['seal.mjs dated', 'seal.mjs undated']);
});

test('output renders through renderKnownFalseMd', () => {
  const p = project([carried(1, { claim: 'seal.mjs retries', actual: 'four attempts' })]);
  const got = listRefutationsForDiff(p.sessionDir, { forgeDir: p.forgeDir, basenames: ['seal.mjs'] });
  assert.match(renderKnownFalseMd(got), /KF1 \[reviewer, 1\.1\] \(from change-1\): seal\.mjs retries → \*\*actual:\*\* four attempts/);
});

/** A git repo with a base commit and one modified + one added tracked file. */
function gitRepo() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'forge-refute-git-'));
  const git = (...a) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  git('init', '-q');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'seal.mjs'), 'a\n');
  fs.writeFileSync(path.join(root, 'README.md'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(root, 'src', 'seal.mjs'), 'b\n');
  fs.writeFileSync(path.join(root, 'src', 'ledger.mjs'), 'new\n');
  git('add', 'src/ledger.mjs');
  git('commit', '-q', '-am', 'change');
  return { root, git };
}

test('changedBasenames returns the basenames `git diff --name-only <range>` lists', () => {
  const { root } = gitRepo();
  assert.deepEqual(changedBasenames('HEAD~1..HEAD', root).sort(), ['ledger.mjs', 'seal.mjs']);
});

test('changedBasenames throws on a range git rejects', () => {
  const { root } = gitRepo();
  assert.throws(() => changedBasenames('no-such-ref..HEAD', root), /git diff/);
});

test('forge refute list --md --for-diff <range> end to end: session entries plus matching carried entries', () => {
  const { root } = gitRepo();
  const forgeDir = path.join(root, '.forge');
  const sessionDir = path.join(forgeDir, 'sessions', SESSION);
  fs.mkdirSync(sessionDir, { recursive: true });
  addRefutation(sessionDir, { task: '1.1', claim: 'session claim', actual: 'session actual' }, NOW);
  fs.writeFileSync(
    path.join(forgeDir, 'known-false.jsonl'),
    [
      carried(1, { claim: 'seal.mjs matches' }),
      carried(2, { claim: 'only mentions notes.txt, which this diff does not touch' }),
    ]
      .map((c) => `${JSON.stringify(c)}\n`)
      .join(''),
  );
  const r = spawnSync(
    process.execPath,
    [FORGE, 'refute', 'list', '--md', '--for-diff', 'HEAD~1..HEAD', '--session', SESSION],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /session claim/);
  assert.match(r.stdout, /seal\.mjs matches/);
  assert.doesNotMatch(r.stdout, /notes\.txt/);
});

test('parseArgs reads --for-diff and requires a range', () => {
  assert.equal(parseArgs(['list', '--md', '--for-diff', 'main..HEAD']).forDiff, 'main..HEAD');
  assert.equal(parseArgs(['list']).forDiff, null);
  assert.throws(() => parseArgs(['list', '--for-diff']), /--for-diff/);
});
