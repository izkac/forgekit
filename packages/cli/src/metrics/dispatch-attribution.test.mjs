import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { appendDispatch } from './dispatches.mjs';

/**
 * F18: the dispatch log credited the checkout's *active* session, so a second Forge session driven
 * by another host conversation in the same folder had its dispatches counted in the wrong session
 * (seen 2026-10-24: escape-pace-f16's implementers landed in cost-levers' log). A dispatch now goes
 * to the session bound to the host conversation that made it.
 */

function forgeDir({ sessions, active }) {
  const dir = path.join(fs.mkdtempSync(path.join(tmpdir(), 'forge-dispatch-attr-')), '.forge');
  for (const [id, s] of Object.entries(sessions)) {
    fs.mkdirSync(path.join(dir, 'sessions', id), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sessions', id, 'session.json'), `${JSON.stringify({ id, phase: 'implement', ...s })}\n`);
  }
  fs.writeFileSync(path.join(dir, 'active.json'), `${JSON.stringify({ sessionId: active })}\n`);
  return dir;
}

const rows = (dir, id) => {
  const f = path.join(dir, 'sessions', id, 'dispatches.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : [];
};
const ROW = { tool: 'Agent', decision: 'allow' };

test('a dispatch from the conversation bound to another session goes to that session, not the active one', () => {
  const dir = forgeDir({ active: 's1', sessions: { s1: { host: { sessionIds: ['h1'] } }, s2: { host: { sessionIds: ['h2'] } } } });
  assert.equal(appendDispatch(ROW, { forgeDir: dir, hostSessionId: 'h2' }), true);
  assert.equal(rows(dir, 's2').length, 1);
  assert.equal(rows(dir, 's1').length, 0);
});

test('a dispatch from the active session’s own conversation stays with it', () => {
  const dir = forgeDir({ active: 's1', sessions: { s1: { host: { sessionIds: ['h0', 'h1'] } }, s2: { host: { sessionIds: ['h2'] } } } });
  appendDispatch(ROW, { forgeDir: dir, hostSessionId: 'h1' });
  assert.equal(rows(dir, 's1').length, 1);
  assert.equal(rows(dir, 's2').length, 0);
});

test('a dispatch from an unknown conversation is not credited to a session bound to another one', () => {
  const dir = forgeDir({ active: 's1', sessions: { s1: { host: { sessionIds: ['h1'] } } } });
  assert.equal(appendDispatch(ROW, { forgeDir: dir, hostSessionId: 'h9' }), false);
  assert.equal(rows(dir, 's1').length, 0);
});

test('a finished session bound to the conversation is not a target', () => {
  const dir = forgeDir({ active: 's1', sessions: { s1: { host: { sessionIds: ['h1'] } }, s2: { phase: 'done', host: { sessionIds: ['h2'] } } } });
  assert.equal(appendDispatch(ROW, { forgeDir: dir, hostSessionId: 'h2' }), false);
  assert.equal(rows(dir, 's2').length, 0);
});

test('the model hook passes the hook input’s session_id through, so its dispatch lands in the bound session', async () => {
  const { runEnforceModel } = await import('../enforce-model.mjs');
  const dir = forgeDir({ active: 's1', sessions: { s1: { host: { sessionIds: ['h1'] } }, s2: { host: { sessionIds: ['h2'] } } } });
  const sink = { write() {} };
  const input = JSON.stringify({ session_id: 'h2', tool_name: 'Agent', tool_input: { prompt: 'x', model: 'sonnet' } });
  const code = await runEnforceModel(['--forge-dir', dir, '--agent', 'claude-code'], { input, stdout: sink });
  assert.equal(code, 0);
  assert.equal(rows(dir, 's2').length, 1, 'credited to the session bound to h2');
  assert.equal(rows(dir, 's1').length, 0, 'not to the active session of another conversation');
});

test('an unbound active session, or no host id at all, keeps the old behavior', () => {
  const unbound = forgeDir({ active: 's1', sessions: { s1: {} } });
  appendDispatch(ROW, { forgeDir: unbound, hostSessionId: 'h9' });
  assert.equal(rows(unbound, 's1').length, 1);
  const noHost = forgeDir({ active: 's1', sessions: { s1: { host: { sessionIds: ['h1'] } } } });
  appendDispatch(ROW, { forgeDir: noHost });
  assert.equal(rows(noHost, 's1').length, 1);
});
