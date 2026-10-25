/**
 * Coordinator vs subagent requests (cost-levers task 3.1): mean context per
 * coordinator request, the per-group split, and the digest carrying both.
 *
 * Every expected number is computed from the fixture below — each request is
 * tagged with the bucket it must land in, so a wrong window rule cannot hide
 * behind a typed-in count.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { collectMetrics } from './collect.mjs';
import { appendSessionDigest, readLedger } from '../ledger.mjs';
import { DEFAULT_HOST_ID, assistantLine, plantHost } from './test-host-tree.mjs';

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

const NOW = () => new Date('2026-07-27T11:00:00.000Z');
const IMPLEMENT_AT = '2026-07-27T10:10:00.000Z';
const CHECKPOINT_1 = '2026-07-27T10:20:00.000Z';
const CHECKPOINT_2 = '2026-07-27T10:40:00.000Z';

/**
 * Parent (`who: 'p'`) and subagent (`who: 's'`) requests, each tagged with the
 * bucket it must land in. Token values all differ, `output` is large so a mean
 * that wrongly includes it is visible, and one request sits exactly on a
 * checkpoint time (the window's inclusive end).
 */
const REQUESTS = [
  { id: 'p_pre', who: 'p', at: '2026-07-27T10:05:00.000Z', bucket: 'pre', tokens: { input: 3, output: 9000, cacheRead: 100, cacheCreate: 7 } },
  { id: 'p_a', who: 'p', at: '2026-07-27T10:15:00.000Z', bucket: 'g1', tokens: { input: 11, output: 9000, cacheRead: 2000, cacheCreate: 13 } },
  { id: 's_a', who: 's', at: '2026-07-27T10:12:00.000Z', bucket: 'g1', tokens: { input: 5000, output: 1, cacheRead: 50000, cacheCreate: 1 } },
  { id: 'p_edge', who: 'p', at: CHECKPOINT_1, bucket: 'g1', tokens: { input: 17, output: 9000, cacheRead: 3000, cacheCreate: 19 } },
  { id: 'p_b', who: 'p', at: '2026-07-27T10:30:00.000Z', bucket: 'g2', tokens: { input: 23, output: 9000, cacheRead: 4000, cacheCreate: 29 } },
  { id: 's_b', who: 's', at: '2026-07-27T10:35:00.000Z', bucket: 'g2', tokens: { input: 6000, output: 1, cacheRead: 60000, cacheCreate: 1 } },
  { id: 's_b2', who: 's', at: '2026-07-27T10:36:00.000Z', bucket: 'g2', tokens: { input: 6001, output: 1, cacheRead: 60001, cacheCreate: 1 } },
  { id: 'p_late', who: 'p', at: '2026-07-27T10:50:00.000Z', bucket: 'late', tokens: { input: 31, output: 9000, cacheRead: 5000, cacheCreate: 37 } },
  { id: 's_late', who: 's', at: '2026-07-27T10:55:00.000Z', bucket: 'late', tokens: { input: 7000, output: 1, cacheRead: 70000, cacheCreate: 1 } },
];

const CHECKPOINTS = [
  { sha: 'aaa111', group: 'one', tasks: '1.1,1.2', at: CHECKPOINT_1 },
  { sha: 'bbb222', group: 'two', tasks: '2.1', at: CHECKPOINT_2 },
];

function session(overrides = {}) {
  return {
    id: '20260727T100000Z-demo-abc123',
    createdAt: '2026-07-27T10:00:00.000Z',
    host: { agent: 'claude-code', sessionIds: [DEFAULT_HOST_ID], boundAt: '2026-07-27T10:00:00.000Z' },
    phaseHistory: [
      { phase: 'plan', at: '2026-07-27T10:01:00.000Z' },
      { phase: 'implement', at: IMPLEMENT_AT },
    ],
    checkpoints: CHECKPOINTS,
    ...overrides,
  };
}

/** Plant a Claude-shaped tree from `REQUESTS`; `mutate` can strip fields off every line. */
function plant(requests = REQUESTS, mutate = (line) => line) {
  const line = (r) =>
    mutate(
      r.who === 'p'
        ? assistantLine({ requestId: r.id, at: r.at, tokens: r.tokens })
        : assistantLine({ requestId: r.id, at: r.at, tokens: r.tokens, isSidechain: true, agentId: 'aaa111' }),
    );
  return plantHost({
    lines: requests.filter((r) => r.who === 'p').map(line),
    subagents: {
      aaa111: {
        meta: { agentType: 'general-purpose', description: 'work', toolUseId: 'toolu_x', spawnDepth: 1, model: 'opus' },
        lines: requests.filter((r) => r.who === 's').map(line),
      },
    },
  });
}

const collect = (configDir, sess = session()) => collectMetrics({ session: sess, now: NOW, configDir });
const countIn = (who, bucket) => REQUESTS.filter((r) => r.who === who && r.bucket === bucket).length;
const context = (t) => t.input + t.cacheRead + t.cacheCreate;

test('coordinator.meanContextTokens is parent context (input + cacheRead + cacheCreate) per parent request', () => {
  const doc = collect(plant());

  const parents = REQUESTS.filter((r) => r.who === 'p');
  const expected = Math.round(parents.reduce((sum, r) => sum + context(r.tokens), 0) / parents.length);
  assert.equal(doc.available, true);
  assert.equal(doc.coordinator.meanContextTokens, expected);

  // The same fixture, counted the two wrong ways, must differ — otherwise this
  // test would pass on a mean that included output or the subagent requests.
  const withOutput = Math.round(parents.reduce((s, r) => s + context(r.tokens) + r.tokens.output, 0) / parents.length);
  const withSubagents = Math.round(REQUESTS.reduce((s, r) => s + context(r.tokens), 0) / REQUESTS.length);
  assert.notEqual(expected, withOutput);
  assert.notEqual(expected, withSubagents);
});

test('groups split parent and subagent requests per checkpoint window, with the rest unattributed', () => {
  const doc = collect(plant());

  const row = (group) => doc.groups.find((g) => g.group === group);
  assert.deepEqual(
    doc.groups.map((g) => g.group),
    ['one', 'two', 'unattributed', 'preImplement'],
  );
  assert.equal(row('one').sha, CHECKPOINTS[0].sha);
  assert.equal(row('one').parent.requests, countIn('p', 'g1'), 'a request exactly on the checkpoint time belongs to that group');
  assert.equal(row('one').subagents.requests, countIn('s', 'g1'));
  assert.equal(row('two').parent.requests, countIn('p', 'g2'));
  assert.equal(row('two').subagents.requests, countIn('s', 'g2'));
  assert.equal(row('unattributed').parent.requests, countIn('p', 'late'));
  assert.equal(row('unattributed').subagents.requests, countIn('s', 'late'));
  assert.equal(row('preImplement').parent.requests, countIn('p', 'pre'));
  assert.equal(row('preImplement').subagents.requests, countIn('s', 'pre'));

  // Nothing falls between the buckets.
  const parentSum = doc.groups.reduce((n, g) => n + g.parent.requests, 0);
  const subSum = doc.groups.reduce((n, g) => n + g.subagents.requests, 0);
  assert.equal(parentSum, doc.breakdown.parent.requests);
  assert.equal(subSum, doc.breakdown.subagents.requests);
});

test('a session with no checkpoints has no group split, but still reports the coordinator mean', () => {
  const doc = collect(plant(), session({ checkpoints: [] }));

  assert.equal(doc.groups, null);
  assert.equal(typeof doc.coordinator.meanContextTokens, 'number');
  assert.equal(collect(plant(), session({ checkpoints: undefined })).groups, null);
});

test('a checkpoint without a parsable time is skipped, not guessed', () => {
  const doc = collect(plant(), session({ checkpoints: [{ sha: 'zzz', group: 'x', at: 'nope' }, CHECKPOINTS[0]] }));

  assert.deepEqual(doc.groups.map((g) => g.group), ['one', 'unattributed', 'preImplement']);
  assert.equal(doc.groups.find((g) => g.group === 'unattributed').parent.requests, countIn('p', 'g2') + countIn('p', 'late'));
});

test('a host whose lines do not mark sidechain requests reports null, never an estimate', () => {
  const unmarked = (line) => {
    const copy = { ...line };
    delete copy.isSidechain;
    return copy;
  };
  const doc = collect(plant(REQUESTS, unmarked));

  assert.equal(doc.available, true);
  assert.equal(doc.coordinator, null);
  assert.equal(doc.groups, null);
});

test('the sessions.jsonl digest carries the breakdown, the coordinator mean and the group split', () => {
  const doc = collect(plant());
  const root = tmp('forge-split-digest-');
  const sessionDir = path.join(root, '.forge', 'sessions', 's1');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'metrics.json'), `${JSON.stringify(doc)}\n`, 'utf8');
  const stored = { id: 's1', slug: 'demo', createdAt: doc.window.from, updatedAt: doc.collectedAt, phase: 'done' };

  appendSessionDigest({ cwd: root, sessionDir, session: stored, card: { score: 90, grade: 'A' } });
  const [entry] = readLedger(path.join(root, '.forge', 'sessions.jsonl'));

  assert.deepEqual(entry.requestSplit.breakdown, doc.breakdown);
  assert.deepEqual(entry.requestSplit.coordinator, doc.coordinator);
  assert.deepEqual(entry.requestSplit.groups, doc.groups);
});

test('the digest split is null when no metrics were collected', () => {
  const root = tmp('forge-split-digest-none-');
  const sessionDir = path.join(root, '.forge', 'sessions', 's1');
  fs.mkdirSync(sessionDir, { recursive: true });
  const stored = { id: 's1', slug: 'demo', createdAt: '2026-07-27T10:00:00.000Z', updatedAt: '2026-07-27T11:00:00.000Z', phase: 'done' };

  appendSessionDigest({ cwd: root, sessionDir, session: stored, card: { score: 90, grade: 'A' } });
  const [entry] = readLedger(path.join(root, '.forge', 'sessions.jsonl'));

  assert.equal(entry.requestSplit, null);
});

test('on a host that cannot separate the sides, the digest split is null throughout, breakdown included', () => {
  const unmarked = (line) => {
    const copy = { ...line };
    delete copy.isSidechain;
    return copy;
  };
  const doc = collect(plant(REQUESTS, unmarked));
  assert.notEqual(doc.breakdown, null, 'fixture: metrics.json still holds the file-level breakdown');
  const root = tmp('forge-split-digest-unmarked-');
  const sessionDir = path.join(root, '.forge', 'sessions', 's1');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'metrics.json'), `${JSON.stringify(doc)}\n`, 'utf8');
  const stored = { id: 's1', slug: 'demo', createdAt: doc.window.from, updatedAt: doc.collectedAt, phase: 'done' };

  appendSessionDigest({ cwd: root, sessionDir, session: stored, card: { score: 90, grade: 'A' } });
  const [entry] = readLedger(path.join(root, '.forge', 'sessions.jsonl'));

  assert.deepEqual(entry.requestSplit, { breakdown: null, coordinator: null, groups: null });
});
