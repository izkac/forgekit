import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import {
  EMPTY_DISPATCHES,
  appendDispatch,
  foldDispatches,
  readDispatches,
} from './dispatches.mjs';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

/**
 * A .forge tree with an active session, or with a dangling active.json.
 *
 * @param {{ active?: string | null, sessionExists?: boolean }} [opts]
 * @returns {{ forgeDir: string, sessionDir: string, file: string }}
 */
function forgeTree(opts = {}) {
  const forgeDir = path.join(tmp('forge-dispatch-'), '.forge');
  const sessionId = opts.active === undefined ? 'sess-1' : opts.active;
  fs.mkdirSync(forgeDir, { recursive: true });
  const sessionDir = path.join(forgeDir, 'sessions', sessionId ?? 'sess-1');
  if (opts.sessionExists !== false) fs.mkdirSync(sessionDir, { recursive: true });
  if (sessionId) {
    fs.writeFileSync(
      path.join(forgeDir, 'active.json'),
      `${JSON.stringify({ sessionId })}\n`,
      'utf8',
    );
  }
  return { forgeDir, sessionDir, file: path.join(sessionDir, 'dispatches.jsonl') };
}

const ROW = {
  tool: 'Agent',
  agentType: 'general-purpose',
  modelRequested: 'sonnet',
  modelResolved: 'opus',
  decision: 'rewrite',
  reason: 'flattened-tiers',
  toolUseId: 'toolu_01ABC',
};

test('a dispatch is appended to the active session, stamped with a time', () => {
  const { forgeDir, file } = forgeTree();

  assert.equal(appendDispatch(ROW, { forgeDir }), true);
  assert.equal(appendDispatch({ ...ROW, decision: 'deny' }, { forgeDir }), true);

  const rows = readDispatches(path.dirname(file));
  assert.equal(rows.length, 2, 'appends, never replaces — a session dispatches many times');
  assert.deepEqual({ ...rows[0], ts: undefined }, { ...ROW, ts: undefined });
  assert.ok(!Number.isNaN(Date.parse(rows[0].ts)), `not a timestamp: ${rows[0].ts}`);
  assert.equal(rows[1].decision, 'deny');
});

test('an absent toolUseId is omitted rather than written as null', () => {
  // The host does not promise this field on every payload; a row that carries
  // it can be joined to a subagent sidecar record, and one that cannot should
  // say so by its absence.
  const { forgeDir, file } = forgeTree();
  appendDispatch({ ...ROW, toolUseId: null }, { forgeDir });

  const [row] = readDispatches(path.dirname(file));
  assert.equal('toolUseId' in row, false);
  assert.equal(row.agentType, ROW.agentType);
});

test('with no active session nothing is written anywhere', () => {
  // The hook runs on every dispatch in every project, most of which have no
  // Forge session at all. Silence is the correct behaviour, not a stray file.
  const { forgeDir } = forgeTree({ active: null });
  assert.equal(appendDispatch(ROW, { forgeDir }), false);
  assert.equal(fs.existsSync(path.join(forgeDir, 'sessions')), true);
  assert.deepEqual(fs.readdirSync(path.join(forgeDir, 'sessions', 'sess-1')), []);
});

test('an active.json pointing at a deleted session writes nothing', () => {
  const { forgeDir, sessionDir } = forgeTree({ sessionExists: false });
  assert.equal(appendDispatch(ROW, { forgeDir }), false);
  assert.equal(fs.existsSync(sessionDir), false, 'a stale pointer must not resurrect the dir');
});

test('appendDispatch never throws, whatever it is handed', () => {
  const { forgeDir, file } = forgeTree();
  // The one failure a tolerant writer cannot avoid: the path is a directory.
  fs.mkdirSync(file);
  assert.equal(appendDispatch(ROW, { forgeDir }), false);

  assert.equal(appendDispatch(ROW, { forgeDir: '/nonexistent/nope/.forge' }), false);
  assert.equal(appendDispatch(null, { forgeDir }), false);
  assert.equal(appendDispatch(ROW, { cwd: '/nonexistent/nope' }), false);
});

test('a corrupt line does not hide the dispatches around it', () => {
  const { forgeDir, file } = forgeTree();
  appendDispatch(ROW, { forgeDir });
  fs.appendFileSync(file, '{"decision": "den\n', 'utf8');
  appendDispatch({ ...ROW, decision: 'allow' }, { forgeDir });

  const rows = readDispatches(path.dirname(file));
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.decision),
    ['rewrite', 'allow'],
  );
});

test('readDispatches returns [] for a session that never dispatched', () => {
  const { sessionDir } = forgeTree();
  assert.deepEqual(readDispatches(sessionDir), []);
  assert.deepEqual(readDispatches('/nonexistent'), []);
  assert.deepEqual(readDispatches(null), []);
});

test('foldDispatches counts decisions, and calls a corrected dispatch skipped', () => {
  // `skipped` is the headline number: how often the coordinator's own model
  // choice did not match the policy, which is the behaviour this change exists
  // to measure. Both a rewrite and a denial mean forge resolve-model was
  // skipped or ignored.
  const rows = [
    { decision: 'allow' },
    { decision: 'allow' },
    { decision: 'rewrite' },
    { decision: 'rewrite' },
    { decision: 'rewrite' },
    { decision: 'deny' },
  ];
  assert.deepEqual(foldDispatches(rows), {
    total: 6,
    allowed: 2,
    rewritten: 3,
    denied: 1,
    skipped: 4,
  });
});

test('folding nothing yields zeros, which is not the same as no answer', () => {
  // A session that dispatched no subagents genuinely has zero of each. This
  // must never degrade the metrics document to available:false.
  assert.deepEqual(foldDispatches([]), EMPTY_DISPATCHES);
  assert.deepEqual(foldDispatches(null), EMPTY_DISPATCHES);
  assert.deepEqual(foldDispatches([{ decision: 'wat' }, {}, null]), {
    ...EMPTY_DISPATCHES,
    total: 3,
  });
  assert.equal(EMPTY_DISPATCHES.skipped, 0);
});
