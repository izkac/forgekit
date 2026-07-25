import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { appendDeferralLedger, appendSessionDigest, readLedger } from './ledger.mjs';

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

function makeSession(root, id = 's1', overrides = {}) {
  const sessionDir = path.join(root, '.forge', 'sessions', id);
  fs.mkdirSync(path.join(sessionDir, 'tasks', '01-model'), { recursive: true });
  const session = {
    id,
    slug: 'add-billing',
    openspecChange: 'add-billing',
    phase: 'done',
    planType: 'specs',
    tasksTotal: 20,
    tasksComplete: 20,
    subagentsDispatched: 12,
    createdAt: '2026-07-25T08:00:00.000Z',
    updatedAt: '2026-07-25T14:30:00.000Z',
    checkpoints: [{ sha: 'abc123', group: '01', tasks: '1.1-1.4', at: '2026-07-25T09:00:00.000Z' }],
    ...overrides,
  };
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify(session, null, 2)}\n`,
    'utf8',
  );
  return { sessionDir, session };
}

test('a session digest survives the deletion of its session dir', () => {
  // cleanup-sessions removes the whole session dir at done, taking reviews,
  // deferrals and evidence with it — 5 of volo's 6 scored sessions were
  // already gone, so what review actually caught existed nowhere.
  const root = tmp('forge-ledger-');
  const { sessionDir, session } = makeSession(root);
  fs.writeFileSync(
    path.join(sessionDir, 'tasks', '01-model', 'group-review.md'),
    '# Group review\n\n**Verdict: APPROVED** (opus reviewer 9f2)\n\n## Round 1 — REJECTED\n',
    'utf8',
  );

  appendSessionDigest({ cwd: root, sessionDir, session, card: { score: 88, grade: 'B' } });

  fs.rmSync(sessionDir, { recursive: true, force: true });
  const [entry] = readLedger(path.join(root, '.forge', 'sessions.jsonl'));

  assert.equal(entry.sessionId, 's1');
  assert.equal(entry.slug, 'add-billing');
  assert.equal(entry.score, 88);
  assert.equal(entry.tasks, '20/20');
  assert.equal(entry.subagentsDispatched, 12);
  assert.equal(entry.reviews.independent, 1);
  assert.equal(entry.reviews.rejections, 1);
  assert.equal(entry.checkpoints, 1);
  assert.equal(entry.durationHours, 6.5);
});

test('the digest records the health verdict, not just the score', () => {
  const root = tmp('forge-ledger-health-');
  const { sessionDir, session } = makeSession(root, 's2', { phase: 'implement' });
  fs.writeFileSync(
    path.join(sessionDir, 'verify-evidence.md'),
    '# Verify\n\nBLOCKED — no runtime owner for the queue worker.\n',
    'utf8',
  );

  appendSessionDigest({ cwd: root, sessionDir, session, card: { score: 40, grade: 'D' } });
  const [entry] = readLedger(path.join(root, '.forge', 'sessions.jsonl'));

  assert.equal(entry.health, 'red');
  assert.match(entry.healthReasons.join(' '), /BLOCKED/);
});

test('re-running a digest replaces that session line instead of duplicating it', () => {
  const root = tmp('forge-ledger-dupe-');
  const { sessionDir, session } = makeSession(root);
  appendSessionDigest({ cwd: root, sessionDir, session, card: { score: 70, grade: 'C' } });
  appendSessionDigest({ cwd: root, sessionDir, session, card: { score: 88, grade: 'B' } });

  const entries = readLedger(path.join(root, '.forge', 'sessions.jsonl'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].score, 88);
});

test('unresolved deferrals outlive the session that raised them', () => {
  // volo carried four standing deferrals that lived only in analysis reports:
  // per-session deferrals.json is deleted with the session dir.
  const root = tmp('forge-ledger-defer-');
  const { sessionDir, session } = makeSession(root);
  fs.writeFileSync(
    path.join(sessionDir, 'deferrals.json'),
    `${JSON.stringify({
      deferrals: [
        { task: '5.4', reason: 'gating tests land in group 6', createdAt: '2026-07-25T10:00:00.000Z', resolvedAt: '2026-07-25T11:00:00.000Z' },
        { task: '7.1', reason: 'grouping.ts D1 extraction — three duplicated pipelines', createdAt: '2026-07-25T12:00:00.000Z' },
      ],
    })}\n`,
    'utf8',
  );

  const written = appendDeferralLedger({ cwd: root, sessionDir, session });
  assert.equal(written, 1, 'only the unresolved one is debt worth carrying');

  fs.rmSync(sessionDir, { recursive: true, force: true });
  const entries = readLedger(path.join(root, '.forge', 'deferrals.jsonl'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].task, '7.1');
  assert.equal(entries[0].sessionId, 's1');
  assert.equal(entries[0].change, 'add-billing');
  assert.match(entries[0].reason, /grouping\.ts/);
});

test('a session with no deferrals writes no ledger noise', () => {
  const root = tmp('forge-ledger-empty-');
  const { sessionDir, session } = makeSession(root);
  assert.equal(appendDeferralLedger({ cwd: root, sessionDir, session }), 0);
  assert.equal(fs.existsSync(path.join(root, '.forge', 'deferrals.jsonl')), false);
});

test('readLedger tolerates a truncated or corrupt line', () => {
  const root = tmp('forge-ledger-corrupt-');
  const file = path.join(root, 'x.jsonl');
  fs.writeFileSync(file, '{"a":1}\n{ broken\n{"a":2}\n', 'utf8');
  assert.deepEqual(readLedger(file), [{ a: 1 }, { a: 2 }]);
});
