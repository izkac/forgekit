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

test('detectHost reports cursor from CURSOR_CONVERSATION_ID when Claude id is absent', () => {
  assert.deepEqual(detectHost({ CURSOR_CONVERSATION_ID: ID_C, CURSOR_AGENT: '1' }), {
    agent: 'cursor',
    sessionId: ID_C,
  });
});

test('detectHost prefers CURSOR_CONVERSATION_ID over CURSOR_TRACE_ID', () => {
  assert.deepEqual(
    detectHost({ CURSOR_CONVERSATION_ID: ID_A, CURSOR_TRACE_ID: ID_B }),
    { agent: 'cursor', sessionId: ID_A },
  );
});

test('detectHost falls back to CURSOR_TRACE_ID when conversation id is blank', () => {
  assert.deepEqual(detectHost({ CURSOR_CONVERSATION_ID: '  ', CURSOR_TRACE_ID: ID_B }), {
    agent: 'cursor',
    sessionId: ID_B,
  });
});

test('detectHost Claude id wins over Cursor ids', () => {
  assert.deepEqual(
    detectHost({
      CLAUDE_CODE_SESSION_ID: ID_A,
      CURSOR_CONVERSATION_ID: ID_C,
      CURSOR_TRACE_ID: ID_B,
    }),
    { agent: 'claude-code', sessionId: ID_A },
  );
});

test('detectHost ignores blank Cursor ids', () => {
  assert.deepEqual(detectHost({ CURSOR_CONVERSATION_ID: '', CURSOR_TRACE_ID: '   ' }), {
    agent: 'unknown',
    sessionId: null,
  });
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

test('bindHost records cursor agent and sets cursorChatId from conversation id', () => {
  const session = { cursorChatId: null };
  bindHost(
    session,
    { CURSOR_CONVERSATION_ID: ID_C },
    clock('2026-07-31T15:00:00.000Z'),
  );

  assert.equal(session.host.agent, 'cursor');
  assert.deepEqual(session.host.sessionIds, [ID_C]);
  assert.equal(session.cursorChatId, ID_C);
});

test('bindHost does not overwrite an existing cursorChatId', () => {
  const session = { cursorChatId: 'already-set' };
  bindHost(session, { CURSOR_CONVERSATION_ID: ID_C }, clock('2026-07-31T15:00:00.000Z'));

  assert.equal(session.cursorChatId, 'already-set');
  assert.deepEqual(session.host.sessionIds, [ID_C]);
});

test('bindHost with only CURSOR_TRACE_ID does not set cursorChatId', () => {
  const session = { cursorChatId: null };
  bindHost(session, { CURSOR_TRACE_ID: ID_B }, clock('2026-07-31T15:00:00.000Z'));

  assert.equal(session.host.agent, 'cursor');
  assert.deepEqual(session.host.sessionIds, [ID_B]);
  assert.equal(session.cursorChatId, null);
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

  assert.deepEqual(findTranscripts([ID_A, ID_B], { configDir }), {
    found: [
      { sessionId: ID_A, transcript: path.join(projA, `${ID_A}.jsonl`), sidecarDir: sidecar },
      { sessionId: ID_B, transcript: path.join(projB, `${ID_B}.jsonl`), sidecarDir: null },
    ],
    unreadable: [],
  });
});

test('findTranscripts omits ids with no transcript on disk', () => {
  const { configDir } = fixture('forge-host-miss-');

  const { found, unreadable } = findTranscripts([ID_C, ID_A], { configDir });
  assert.deepEqual(
    found.map((f) => f.sessionId),
    [ID_A],
  );
  assert.deepEqual(unreadable, []);
});

test('findTranscripts returns [] for no ids at all', () => {
  const { configDir } = fixture('forge-host-none-');
  assert.deepEqual(findTranscripts([], { configDir }), { found: [], unreadable: [] });
});

test('findTranscripts resolves the config dir from CLAUDE_CONFIG_DIR', () => {
  const { configDir, projA } = fixture('forge-host-env-');

  assert.deepEqual(
    findTranscripts([ID_A], {
      env: { CLAUDE_CONFIG_DIR: configDir },
      homedir: () => '/nonexistent-home',
    }),
    {
      found: [
        {
          sessionId: ID_A,
          transcript: path.join(projA, `${ID_A}.jsonl`),
          sidecarDir: path.join(projA, ID_A, 'subagents'),
        },
      ],
      unreadable: [],
    },
  );
});

test('findTranscripts falls back to <homedir>/.claude', () => {
  const { configDir, projA } = fixture('forge-host-home-');
  const home = tmp('forge-host-fakehome-');
  fs.renameSync(configDir, path.join(home, '.claude'));
  const moved = path.join(home, '.claude', 'projects', path.basename(projA));

  assert.deepEqual(findTranscripts([ID_A], { env: {}, homedir: () => home }), {
    found: [
      {
        sessionId: ID_A,
        transcript: path.join(moved, `${ID_A}.jsonl`),
        sidecarDir: path.join(moved, ID_A, 'subagents'),
      },
    ],
    unreadable: [],
  });
});

test('findTranscripts returns [] when projects/ is missing rather than throwing', () => {
  const configDir = tmp('forge-host-empty-');
  assert.deepEqual(findTranscripts([ID_A], { configDir }), { found: [], unreadable: [] });
  assert.deepEqual(findTranscripts([ID_A], { configDir: path.join(configDir, 'nope') }), {
    found: [],
    unreadable: [],
  });
});

test('findTranscripts finds a transcript in the second project directory after an EACCES in the first', () => {
  // Scenario 1: found-elsewhere wins. The first project directory an id is
  // *not* in is unsearchable, but the id's transcript is in the second,
  // readable one. A naive "remember any error" implementation would report
  // this id unreadable even though it was found — this is the guard against
  // over-reporting the brief calls out as the dangerous direction.
  const { configDir, projA, projB } = fixture('forge-host-eacces-found-');
  fs.chmodSync(projA, 0o000);
  try {
    // Prove the fixture is genuinely unreadable before trusting the assertions
    // below — a quietly-readable directory would make this test pass for free.
    assert.throws(() => fs.statSync(path.join(projA, `${ID_B}.jsonl`)), /EACCES/);

    // This test's discriminating power — catching `if (blocked)` in place of
    // `if (!matched && blocked)` — depends on readdirSync visiting the
    // blocked directory before the one that holds the transcript: only then
    // does `blocked` get set before the inner loop breaks on the match.
    // readdirSync order is not guaranteed, so assert the precondition rather
    // than assume it — a reordering filesystem must redden this test, not
    // pass it without ever exercising the over-reporting path.
    const projects = path.join(configDir, 'projects');
    assert.equal(
      fs.readdirSync(projects)[0],
      path.basename(projA),
      'fixture assumes projA is enumerated before projB; this test is vacuous otherwise',
    );

    const { found, unreadable } = findTranscripts([ID_B], { configDir });

    assert.deepEqual(found, [
      { sessionId: ID_B, transcript: path.join(projB, `${ID_B}.jsonl`), sidecarDir: null },
    ]);
    assert.deepEqual(unreadable, []);
  } finally {
    fs.chmodSync(projA, 0o755);
  }
});

test('findTranscripts scopes `blocked` to one id, not the whole call', () => {
  // Pins the boundary the reviewer's mutant erases: hoist `let blocked = null`
  // one scope out of `for (const sessionId of ids)` and it survives across
  // ids instead of resetting per id. A second id, absent everywhere and never
  // blocked itself, then inherits the *first* id's blocked path and reason —
  // a session refused at the gate for a directory failure that belongs to a
  // different session. Every other test in this file calls findTranscripts
  // with a single id, so nothing else here pins this boundary.
  const configDir = tmp('forge-host-blocked-scope-');
  const proj = path.join(configDir, 'projects', '-a');
  fs.mkdirSync(proj, { recursive: true });
  // A regular file named `blocker` makes any id whose own name walks through
  // it — via a literal `/` — fail with ENOTDIR rather than ENOENT: blocked,
  // not absent, and only for the one id whose path traverses it.
  fs.writeFileSync(path.join(proj, 'blocker'), 'not a directory', 'utf8');
  const BLOCKED_ID = 'blocker/deadbeef';
  const ABSENT_ID = 'cccccccc-0000-4000-8000-000000000009';
  const blockedPath = path.join(proj, `${BLOCKED_ID}.jsonl`);
  assert.throws(
    () => fs.statSync(blockedPath),
    /ENOTDIR/,
    'fixture must genuinely block this id, not just miss it',
  );

  const { found, unreadable } = findTranscripts([BLOCKED_ID, ABSENT_ID], { configDir });

  assert.deepEqual(found, []);
  assert.equal(unreadable.length, 1, "the absent id must not inherit the blocked id's entry");
  assert.equal(unreadable[0].sessionId, BLOCKED_ID);
  assert.equal(unreadable[0].path, blockedPath);
  assert.match(unreadable[0].reason, /ENOTDIR/);
});

test('findTranscripts reports an id as unreadable when it is found in no project directory and one is unsearchable', () => {
  // Scenario 2: found nowhere, with a directory blocked along the way. The id
  // is genuinely absent from every project directory, but one of those
  // directories could not be searched at all — so "absent" cannot be
  // concluded, and the id must be reported unreadable rather than silently
  // dropped the way a pruned transcript would be.
  const { configDir, projA } = fixture('forge-host-eacces-miss-');
  fs.chmodSync(projA, 0o000);
  try {
    assert.throws(() => fs.statSync(path.join(projA, `${ID_C}.jsonl`)), /EACCES/);

    const { found, unreadable } = findTranscripts([ID_C], { configDir });

    assert.deepEqual(found, []);
    assert.equal(unreadable.length, 1);
    assert.equal(unreadable[0].sessionId, ID_C);
    assert.equal(unreadable[0].path, path.join(projA, `${ID_C}.jsonl`));
    assert.match(unreadable[0].reason, /EACCES/);
  } finally {
    fs.chmodSync(projA, 0o755);
  }
});

test('findTranscripts omits an id absent from every readable project directory, and never marks it unreadable', () => {
  // Scenario 3: the pruned case, and it must stay cheap — no chmod at all,
  // every directory readable, the id simply is not there.
  const { configDir } = fixture('forge-host-absent-clean-');

  const { found, unreadable } = findTranscripts([ID_C], { configDir });

  assert.deepEqual(found, []);
  assert.deepEqual(unreadable, []);
});

test('findTranscripts reports a sidecar path that exists but is not a directory as unreadable', () => {
  // A regular file where `subagents/` should be a directory: `statSync`
  // succeeds so this is not the ENOENT case, and `isDirectory()` is false —
  // the fourth outcome, distinct from both "resolved" and "ordinarily absent".
  const configDir = tmp('forge-host-sidecar-file-');
  const proj = path.join(configDir, 'projects', '-home-iztok-Projects-forgekit');
  fs.mkdirSync(path.join(proj, ID_A), { recursive: true });
  fs.writeFileSync(path.join(proj, `${ID_A}.jsonl`), '{"type":"user"}\n', 'utf8');
  const sidecar = path.join(proj, ID_A, 'subagents');
  fs.writeFileSync(sidecar, 'not a directory', 'utf8');

  const { found, unreadable } = findTranscripts([ID_A], { configDir });

  // The transcript is still readable, so the id is still in `found` — its
  // lines still count for metrics — with a null sidecar, same as an absent one.
  assert.deepEqual(found, [
    { sessionId: ID_A, transcript: path.join(proj, `${ID_A}.jsonl`), sidecarDir: null },
  ]);
  // And it also lands in `unreadable`, which is the fact that tells a caller
  // like `reviewEvidence` this is not the ordinary "dispatched nothing" case.
  assert.equal(unreadable.length, 1);
  assert.equal(unreadable[0].sessionId, ID_A);
  assert.equal(unreadable[0].path, sidecar);
  assert.match(unreadable[0].reason, /not a directory/i);
});
