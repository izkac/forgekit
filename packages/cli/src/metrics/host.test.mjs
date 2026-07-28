import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { bindHost, detectHost, findTranscripts } from './host.mjs';

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

const ID_A = 'f8447a2f-eb56-41b8-8cc1-16606b862780';
const ID_B = '3aa8398c-0fba-48e5-8171-8b3735d1cc72';
const ID_C = '00000000-0000-4000-8000-000000000000';

const clock = (iso) => () => new Date(iso);

// --- detectHost ------------------------------------------------------------

test('detectHost reports claude-code and the id when CLAUDE_CODE_SESSION_ID is set', () => {
  assert.deepEqual(
    detectHost({ CLAUDE_CODE_SESSION_ID: ID_A, AI_AGENT: 'claude-code_2-1-220_agent' }),
    { agent: 'claude-code', sessionId: ID_A },
  );
});

test('detectHost reports claude-code from the id alone, without AI_AGENT', () => {
  assert.deepEqual(detectHost({ CLAUDE_CODE_SESSION_ID: ID_A }), {
    agent: 'claude-code',
    sessionId: ID_A,
  });
});

test('detectHost reports unknown when the id is absent, even if AI_AGENT looks like a host', () => {
  assert.deepEqual(detectHost({ AI_AGENT: 'claude-code_2-1-220_agent' }), {
    agent: 'unknown',
    sessionId: null,
  });
});

test('detectHost treats an empty or blank id as absent', () => {
  assert.deepEqual(detectHost({ CLAUDE_CODE_SESSION_ID: '' }), {
    agent: 'unknown',
    sessionId: null,
  });
  assert.deepEqual(detectHost({ CLAUDE_CODE_SESSION_ID: '   ' }), {
    agent: 'unknown',
    sessionId: null,
  });
});

test('detectHost never throws on an empty, undefined or non-object env', () => {
  assert.deepEqual(detectHost({}), { agent: 'unknown', sessionId: null });
  assert.deepEqual(detectHost(undefined), { agent: 'unknown', sessionId: null });
  assert.deepEqual(detectHost(null), { agent: 'unknown', sessionId: null });
  assert.deepEqual(detectHost(42), { agent: 'unknown', sessionId: null });
});

// --- bindHost --------------------------------------------------------------

test('bindHost records agent, id and boundAt on a fresh session', () => {
  const session = { id: 's1' };
  const out = bindHost(
    session,
    { CLAUDE_CODE_SESSION_ID: ID_A },
    clock('2026-07-27T10:00:00.000Z'),
  );

  assert.equal(out, session, 'returns the same object it mutated');
  assert.equal(session.host.agent, 'claude-code');
  assert.deepEqual(session.host.sessionIds, [ID_A]);
  assert.equal(session.host.boundAt, '2026-07-27T10:00:00.000Z');
});

test('bindHost is idempotent for the same host id', () => {
  const session = {};
  const env = { CLAUDE_CODE_SESSION_ID: ID_A };
  bindHost(session, env, clock('2026-07-27T10:00:00.000Z'));
  bindHost(session, env, clock('2026-07-27T11:00:00.000Z'));

  assert.deepEqual(session.host.sessionIds, [ID_A]);
});

test('bindHost does not overwrite boundAt on a later bind', () => {
  const session = {};
  bindHost(session, { CLAUDE_CODE_SESSION_ID: ID_A }, clock('2026-07-27T10:00:00.000Z'));
  bindHost(session, { CLAUDE_CODE_SESSION_ID: ID_B }, clock('2026-07-27T11:00:00.000Z'));

  assert.equal(session.host.boundAt, '2026-07-27T10:00:00.000Z');
});

test('bindHost appends a second host id and keeps the first', () => {
  const session = {};
  bindHost(session, { CLAUDE_CODE_SESSION_ID: ID_A }, clock('2026-07-27T10:00:00.000Z'));
  bindHost(session, { CLAUDE_CODE_SESSION_ID: ID_B }, clock('2026-07-27T11:00:00.000Z'));

  assert.deepEqual(session.host.sessionIds, [ID_A, ID_B]);
  assert.equal(session.host.agent, 'claude-code');
});

test('bindHost with no host env yields agent unknown and no ids', () => {
  const session = {};
  bindHost(session, {}, clock('2026-07-27T10:00:00.000Z'));

  assert.equal(session.host.agent, 'unknown');
  assert.deepEqual(session.host.sessionIds, []);
});

test('bindHost does not stamp boundAt when there is nothing to bind to', () => {
  // A boundAt on a session with no ids names a moment when nothing was bound.
  const session = {};
  bindHost(session, {}, clock('2026-07-27T10:00:00.000Z'));
  assert.equal(session.host.boundAt, undefined);

  // The first id actually recorded is what stamps it — not retroactively.
  bindHost(session, { CLAUDE_CODE_SESSION_ID: ID_A }, clock('2026-07-27T11:00:00.000Z'));
  assert.equal(session.host.boundAt, '2026-07-27T11:00:00.000Z');
});

test('bindHost with no host env does not clobber an existing binding', () => {
  const session = {};
  bindHost(session, { CLAUDE_CODE_SESSION_ID: ID_A }, clock('2026-07-27T10:00:00.000Z'));
  bindHost(session, {}, clock('2026-07-27T11:00:00.000Z'));

  assert.equal(session.host.agent, 'claude-code');
  assert.deepEqual(session.host.sessionIds, [ID_A]);
  assert.equal(session.host.boundAt, '2026-07-27T10:00:00.000Z');
});

test('bindHost upgrades a legacy session that has no host field', () => {
  const session = { id: 'legacy', phase: 'implement' };
  bindHost(session, { CLAUDE_CODE_SESSION_ID: ID_A }, clock('2026-07-27T10:00:00.000Z'));

  assert.equal(session.phase, 'implement', 'leaves unrelated fields alone');
  assert.deepEqual(session.host.sessionIds, [ID_A]);
});

test('bindHost repairs a malformed host field instead of throwing', () => {
  const session = { host: { agent: 'claude-code', sessionIds: 'not-an-array' } };
  bindHost(session, { CLAUDE_CODE_SESSION_ID: ID_A }, clock('2026-07-27T10:00:00.000Z'));

  assert.deepEqual(session.host.sessionIds, [ID_A]);
});

test('bindHost replaces an array host instead of binding into it', () => {
  // `typeof [] === 'object'`, so an array would be kept and then quietly
  // defeat binding: sessionIds is not an array property of it, and agent
  // lands on an array. A non-plain-object host is as good as missing.
  const session = { host: [] };
  bindHost(session, { CLAUDE_CODE_SESSION_ID: ID_A }, clock('2026-07-27T10:00:00.000Z'));

  assert.equal(Array.isArray(session.host), false);
  assert.equal(session.host.agent, 'claude-code');
  assert.deepEqual(session.host.sessionIds, [ID_A]);
  assert.equal(session.host.boundAt, '2026-07-27T10:00:00.000Z');
});

test('bindHost defaults its clock to the real one', () => {
  const before = Date.now();
  const session = {};
  bindHost(session, { CLAUDE_CODE_SESSION_ID: ID_A });

  const boundAt = new Date(session.host.boundAt).getTime();
  assert.ok(boundAt >= before && boundAt <= Date.now(), `boundAt out of range: ${boundAt}`);
});

// --- findTranscripts -------------------------------------------------------

/**
 * Two project directories, a transcript for each of two ids, and a subagent
 * sidecar for the first only — mirrors the measured ~/.claude layout.
 */
function fixture(prefix) {
  const configDir = tmp(prefix);
  const projects = path.join(configDir, 'projects');
  const projA = path.join(projects, '-home-iztok-Projects-forgekit');
  const projB = path.join(projects, '-home-iztok-Projects-other');
  const sidecar = path.join(projA, ID_A, 'subagents');
  fs.mkdirSync(sidecar, { recursive: true });
  fs.mkdirSync(projB, { recursive: true });
  fs.writeFileSync(path.join(projA, `${ID_A}.jsonl`), '{"type":"user"}\n', 'utf8');
  fs.writeFileSync(path.join(sidecar, 'agent-a4dfd646d331fdddb.jsonl'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(projB, `${ID_B}.jsonl`), '{"type":"user"}\n', 'utf8');
  return { configDir, projA, projB, sidecar };
}

test('findTranscripts finds transcripts across project directories', () => {
  const { configDir, projA, projB, sidecar } = fixture('forge-host-find-');

  assert.deepEqual(findTranscripts([ID_A, ID_B], { configDir }), [
    { sessionId: ID_A, transcript: path.join(projA, `${ID_A}.jsonl`), sidecarDir: sidecar },
    { sessionId: ID_B, transcript: path.join(projB, `${ID_B}.jsonl`), sidecarDir: null },
  ]);
});

test('findTranscripts omits ids with no transcript on disk', () => {
  const { configDir } = fixture('forge-host-miss-');

  const found = findTranscripts([ID_C, ID_A], { configDir });
  assert.deepEqual(
    found.map((f) => f.sessionId),
    [ID_A],
  );
});

test('findTranscripts returns [] for no ids at all', () => {
  const { configDir } = fixture('forge-host-none-');
  assert.deepEqual(findTranscripts([], { configDir }), []);
});

test('findTranscripts resolves the config dir from CLAUDE_CONFIG_DIR', () => {
  const { configDir, projA } = fixture('forge-host-env-');

  assert.deepEqual(
    findTranscripts([ID_A], {
      env: { CLAUDE_CONFIG_DIR: configDir },
      homedir: () => '/nonexistent-home',
    }),
    [
      {
        sessionId: ID_A,
        transcript: path.join(projA, `${ID_A}.jsonl`),
        sidecarDir: path.join(projA, ID_A, 'subagents'),
      },
    ],
  );
});

test('findTranscripts falls back to <homedir>/.claude', () => {
  const { configDir, projA } = fixture('forge-host-home-');
  const home = tmp('forge-host-fakehome-');
  fs.renameSync(configDir, path.join(home, '.claude'));
  const moved = path.join(home, '.claude', 'projects', path.basename(projA));

  assert.deepEqual(findTranscripts([ID_A], { env: {}, homedir: () => home }), [
    {
      sessionId: ID_A,
      transcript: path.join(moved, `${ID_A}.jsonl`),
      sidecarDir: path.join(moved, ID_A, 'subagents'),
    },
  ]);
});

test('findTranscripts returns [] when projects/ is missing rather than throwing', () => {
  const configDir = tmp('forge-host-empty-');
  assert.deepEqual(findTranscripts([ID_A], { configDir }), []);
  assert.deepEqual(findTranscripts([ID_A], { configDir: path.join(configDir, 'nope') }), []);
});
