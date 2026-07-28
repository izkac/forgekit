import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { collectMetrics } from './collect.mjs';
import { EMPTY_DISPATCHES } from './dispatches.mjs';

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

const HOST_ID = 'f8447a2f-eb56-41b8-8cc1-16606b862780';

/** A `usage` object in the host's own field names. */
function usage({ input = 0, output = 0, cacheRead = 0, cacheCreate = 0 } = {}) {
  return {
    input_tokens: input,
    cache_creation_input_tokens: cacheCreate,
    cache_read_input_tokens: cacheRead,
    output_tokens: output,
  };
}

/** One assistant transcript line — i.e. one content block of one reply. */
function assistantLine({
  requestId,
  at,
  model = 'claude-opus-5',
  tokens = {},
  block = { type: 'text' },
  version = '2.1.220',
  ...rest
} = {}) {
  return {
    type: 'assistant',
    requestId,
    timestamp: at,
    version,
    isSidechain: false,
    ...rest,
    message: { id: `msg_${requestId}`, model, content: [block], usage: usage(tokens) },
  };
}

/** A `user` line carrying one `tool_result`. */
function toolResultLine({ id, isError = false, at } = {}) {
  return {
    type: 'user',
    timestamp: at,
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] },
  };
}

function jsonl(lines) {
  return lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n');
}

/**
 * Plant a `~/.claude`-shaped tree and return its config dir.
 *
 * `subagents` maps agent id → `{ meta, lines }`, exactly as the host lays them
 * out beside the parent transcript.
 */
function plantHost({ sessionId = HOST_ID, lines = null, subagents = null } = {}) {
  const configDir = tmp('forge-collect-');
  const project = path.join(configDir, 'projects', '-home-iztok-Projects-forgekit');
  fs.mkdirSync(project, { recursive: true });
  if (lines !== null) fs.writeFileSync(path.join(project, `${sessionId}.jsonl`), jsonl(lines));
  if (subagents !== null) {
    const dir = path.join(project, sessionId, 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    for (const [agentId, { meta, lines: agentLines }] of Object.entries(subagents)) {
      if (meta !== undefined) {
        fs.writeFileSync(
          path.join(dir, `agent-${agentId}.meta.json`),
          typeof meta === 'string' ? meta : JSON.stringify(meta),
        );
      }
      if (agentLines !== undefined) {
        fs.writeFileSync(path.join(dir, `agent-${agentId}.jsonl`), jsonl(agentLines));
      }
    }
  }
  return configDir;
}

function transcriptPath(configDir, sessionId = HOST_ID) {
  return path.join(configDir, 'projects', '-home-iztok-Projects-forgekit', `${sessionId}.jsonl`);
}

/** Add token blocks up, so an expectation is derived rather than quoted. */
function sumTokens(...blocks) {
  const total = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  for (const block of blocks) {
    for (const field of Object.keys(total)) total[field] += block[field] ?? 0;
  }
  return total;
}

/**
 * Copy a lookup table into an ordinary object so it can be compared to a
 * literal — `byModel`, `byPhase` and `tools` are prototype-less on purpose.
 */
function plain(table) {
  return { ...table };
}

/** A session bound to `HOST_ID`, created at `createdAt`. */
function boundSession({ createdAt = '2026-07-27T10:00:00.000Z', phaseHistory = [] } = {}) {
  return {
    id: '20260727T100000Z-demo-abc123',
    createdAt,
    host: { agent: 'claude-code', sessionIds: [HOST_ID], boundAt: createdAt },
    phaseHistory,
  };
}

test('collectMetrics degrades when the session was never bound to a host session', () => {
  const doc = collectMetrics({
    session: { id: 's1', createdAt: '2026-07-27T10:00:00.000Z', host: null },
    now: () => new Date('2026-07-27T11:00:00.000Z'),
    configDir: tmp('forge-collect-'),
  });

  assert.equal(doc.available, false);
  assert.equal(doc.collectedAt, '2026-07-27T11:00:00.000Z');
  assert.match(doc.reason, /host session/i);
});

test('collectMetrics degrades when the bound transcript is not on disk', () => {
  // The binding is intact; the host pruned the file, or it belongs to another
  // machine. Normal, and not an error.
  const doc = collectMetrics({
    session: boundSession(),
    now: () => new Date('2026-07-27T11:00:00.000Z'),
    configDir: plantHost({ lines: null }),
  });

  assert.equal(doc.available, false);
  assert.match(doc.reason, /no transcript/i);
  assert.match(doc.reason, new RegExp(HOST_ID));
});

test('collectMetrics rolls a parent transcript up into a document', () => {
  const r1 = { input: 10, output: 100, cacheRead: 1000, cacheCreate: 5 };
  const r2 = { input: 20, output: 200, cacheRead: 2000, cacheCreate: 6 };
  const configDir = plantHost({
    lines: [
      // req_1 restated across two content-block lines, the first carrying the
      // host's preliminary output count. Summing the lines, or keeping the
      // first, both give the wrong answer here.
      assistantLine({
        requestId: 'req_1',
        at: '2026-07-27T10:05:00.000Z',
        tokens: { ...r1, output: 4 },
        block: { type: 'thinking' },
      }),
      assistantLine({
        requestId: 'req_1',
        at: '2026-07-27T10:05:02.000Z',
        tokens: r1,
        block: { type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { command: 'true' } },
      }),
      toolResultLine({ id: 'toolu_a', isError: true, at: '2026-07-27T10:05:03.000Z' }),
      assistantLine({
        requestId: 'req_2',
        at: '2026-07-27T10:06:00.000Z',
        model: 'claude-fable-5',
        tokens: r2,
      }),
    ],
  });

  const doc = collectMetrics({
    session: boundSession(),
    now: () => new Date('2026-07-27T11:00:00.000Z'),
    configDir,
  });

  assert.equal(doc.available, true);
  assert.equal(doc.collectedAt, '2026-07-27T11:00:00.000Z');
  assert.deepEqual(doc.window, {
    from: '2026-07-27T10:00:00.000Z',
    to: '2026-07-27T11:00:00.000Z',
  });
  assert.deepEqual(doc.source, {
    agent: 'claude-code',
    hostVersion: '2.1.220',
    transcripts: [transcriptPath(configDir)],
    sidecars: 0,
  });

  assert.equal(doc.requests, 2);
  assert.deepEqual(doc.tokens, sumTokens(r1, r2));
  assert.deepEqual(plain(doc.byModel), {
    'claude-opus-5': { requests: 1, ...r1 },
    'claude-fable-5': { requests: 1, ...r2 },
  });
  assert.deepEqual(plain(doc.tools), { Bash: { calls: 1, errors: 1 } });
  assert.deepEqual(doc.errors, { toolResults: 1, errorResults: 1, rate: 1 });
  assert.deepEqual(doc.subagents, []);
  assert.deepEqual(doc.breakdown, {
    parent: { requests: 2, tokens: sumTokens(r1, r2) },
    subagents: { requests: 0, tokens: sumTokens() },
  });
});

/** A sidecar assistant line: sidechain, its own agentId. */
function sidecarLine(agentId, options) {
  return assistantLine({ isSidechain: true, agentId, ...options });
}

test('collectMetrics totals cover parent plus every subagent, and breakdown keeps the split', () => {
  const p1 = { input: 10, output: 100, cacheRead: 1000, cacheCreate: 5 };
  const s1 = { input: 20, output: 200, cacheRead: 2000, cacheCreate: 6 };
  const s2 = { input: 30, output: 300, cacheRead: 3000, cacheCreate: 7 };
  const configDir = plantHost({
    lines: [
      assistantLine({
        requestId: 'req_p1',
        at: '2026-07-27T10:05:00.000Z',
        tokens: p1,
        block: { type: 'tool_use', id: 'toolu_task', name: 'Task', input: { prompt: 'go' } },
      }),
      toolResultLine({ id: 'toolu_task', at: '2026-07-27T10:09:00.000Z' }),
    ],
    subagents: {
      aaa111: {
        meta: {
          agentType: 'general-purpose',
          model: 'opus',
          toolUseId: 'toolu_task',
          spawnDepth: 1,
        },
        lines: [
          sidecarLine('aaa111', {
            requestId: 'req_s1',
            at: '2026-07-27T10:06:00.000Z',
            model: 'claude-fable-5',
            tokens: s1,
            block: { type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'true' } },
          }),
          toolResultLine({ id: 'toolu_b', isError: true, at: '2026-07-27T10:06:30.000Z' }),
          sidecarLine('aaa111', {
            requestId: 'req_s2',
            at: '2026-07-27T10:07:00.000Z',
            model: 'claude-fable-5',
            tokens: s2,
          }),
        ],
      },
    },
  });

  const doc = collectMetrics({
    session: boundSession(),
    now: () => new Date('2026-07-27T11:00:00.000Z'),
    configDir,
  });

  assert.equal(doc.available, true);
  assert.equal(doc.source.sidecars, 1);

  assert.equal(doc.requests, 3);
  assert.deepEqual(doc.tokens, sumTokens(p1, s1, s2));
  assert.deepEqual(plain(doc.byModel), {
    'claude-opus-5': { requests: 1, ...p1 },
    'claude-fable-5': { requests: 2, ...sumTokens(s1, s2) },
  });
  assert.deepEqual(plain(doc.tools), {
    Task: { calls: 1, errors: 0 },
    Bash: { calls: 1, errors: 1 },
  });
  assert.deepEqual(doc.errors, { toolResults: 2, errorResults: 1, rate: 0.5 });

  assert.deepEqual(doc.breakdown, {
    parent: { requests: 1, tokens: sumTokens(p1) },
    subagents: { requests: 2, tokens: sumTokens(s1, s2) },
  });

  assert.deepEqual(doc.subagents, [
    {
      agentId: 'aaa111',
      agentType: 'general-purpose',
      modelDispatched: 'opus',
      modelResolved: 'claude-fable-5',
      toolUseId: 'toolu_task',
      spawnDepth: 1,
      requests: 2,
      tokens: sumTokens(s1, s2),
      errors: { toolResults: 1, errorResults: 1, rate: 1 },
    },
  ]);
});

test('collectMetrics counts only the lines inside the session window', () => {
  // One host session, two consecutive Forge sessions. Reading the whole file
  // would bill session Y for session X's work.
  const before = { input: 11, output: 111, cacheRead: 1111, cacheCreate: 1 };
  const edge = { input: 22, output: 222, cacheRead: 2222, cacheCreate: 2 };
  const inside = { input: 33, output: 333, cacheRead: 3333, cacheCreate: 3 };
  const configDir = plantHost({
    lines: [
      // Forge session X — a whole session's worth of work, before Y existed.
      assistantLine({
        requestId: 'req_x',
        at: '2026-07-27T09:30:00.000Z',
        model: 'claude-haiku-5',
        tokens: before,
        block: { type: 'tool_use', id: 'toolu_x', name: 'Glob', input: {} },
      }),
      toolResultLine({ id: 'toolu_x', isError: true, at: '2026-07-27T09:30:01.000Z' }),
      // Forge session Y starts at 10:00:00.000Z — the boundary is inclusive.
      assistantLine({ requestId: 'req_edge', at: '2026-07-27T10:00:00.000Z', tokens: edge }),
      assistantLine({
        requestId: 'req_y',
        at: '2026-07-27T10:30:00.000Z',
        tokens: inside,
        block: { type: 'tool_use', id: 'toolu_y', name: 'Read', input: {} },
      }),
      toolResultLine({ id: 'toolu_y', at: '2026-07-27T10:30:01.000Z' }),
    ],
  });

  const doc = collectMetrics({
    session: boundSession({ createdAt: '2026-07-27T10:00:00.000Z' }),
    now: () => new Date('2026-07-27T11:00:00.000Z'),
    configDir,
  });

  assert.equal(doc.requests, 2);
  assert.deepEqual(doc.tokens, sumTokens(edge, inside));
  assert.deepEqual(plain(doc.byModel), {
    'claude-opus-5': { requests: 2, ...sumTokens(edge, inside) },
  });
  assert.deepEqual(plain(doc.tools), { Read: { calls: 1, errors: 0 } });
  assert.deepEqual(doc.errors, { toolResults: 1, errorResults: 0, rate: 0 });
  assert.deepEqual(doc.breakdown.parent, { requests: 2, tokens: sumTokens(edge, inside) });
});

test('collectMetrics excludes a line whose timestamp cannot be parsed', () => {
  const counted = { input: 5, output: 50, cacheRead: 500, cacheCreate: 5 };
  const configDir = plantHost({
    lines: [
      assistantLine({ requestId: 'req_ok', at: '2026-07-27T10:30:00.000Z', tokens: counted }),
      assistantLine({ requestId: 'req_none', at: undefined, tokens: { output: 999 } }),
      assistantLine({ requestId: 'req_junk', at: 'not a timestamp', tokens: { output: 888 } }),
    ],
  });

  const doc = collectMetrics({
    session: boundSession(),
    now: () => new Date('2026-07-27T11:00:00.000Z'),
    configDir,
  });

  assert.equal(doc.requests, 1);
  assert.deepEqual(doc.tokens, sumTokens(counted));
});

test('collectMetrics windows the sidecars as well as the parent transcript', () => {
  // A sidecar directory belongs to the *host* session, so it accumulates the
  // subagents of every Forge session that ran under it.
  const stale = { input: 44, output: 444, cacheRead: 4444, cacheCreate: 4 };
  const mine = { input: 55, output: 555, cacheRead: 5555, cacheCreate: 5 };
  const configDir = plantHost({
    lines: [assistantLine({ requestId: 'req_p', at: '2026-07-27T10:05:00.000Z' })],
    subagents: {
      old000: {
        meta: { agentType: 'Explore', model: 'haiku', toolUseId: 'toolu_old', spawnDepth: 1 },
        lines: [
          sidecarLine('old000', {
            requestId: 'req_old',
            at: '2026-07-27T09:30:00.000Z',
            model: 'claude-haiku-5',
            tokens: stale,
            block: { type: 'tool_use', id: 'toolu_stale', name: 'Grep', input: {} },
          }),
          toolResultLine({ id: 'toolu_stale', isError: true, at: '2026-07-27T09:30:01.000Z' }),
        ],
      },
      new111: {
        meta: { agentType: 'general-purpose', model: 'opus', toolUseId: 'toolu_new', spawnDepth: 1 },
        lines: [
          sidecarLine('new111', {
            requestId: 'req_new',
            at: '2026-07-27T10:30:00.000Z',
            model: 'claude-opus-5',
            tokens: mine,
          }),
        ],
      },
    },
  });

  const doc = collectMetrics({
    session: boundSession({ createdAt: '2026-07-27T10:00:00.000Z' }),
    now: () => new Date('2026-07-27T11:00:00.000Z'),
    configDir,
  });

  assert.deepEqual(
    doc.subagents.map((record) => record.agentId),
    ['new111'],
  );
  assert.deepEqual(doc.subagents[0].tokens, sumTokens(mine));
  assert.equal(doc.source.sidecars, 1);
  assert.deepEqual(doc.breakdown.subagents, { requests: 1, tokens: sumTokens(mine) });
  assert.deepEqual(plain(doc.tools), {});
  assert.deepEqual(doc.errors, { toolResults: 0, errorResults: 0, rate: 0 });
});

test('collectMetrics degrades when the transcript holds no readable lines', () => {
  const configDir = plantHost({ lines: ['{"half written', 'not json at all', ''] });

  const doc = collectMetrics({
    session: boundSession(),
    now: () => new Date('2026-07-27T11:00:00.000Z'),
    configDir,
  });

  assert.equal(doc.available, false);
  assert.match(doc.reason, /no readable lines/i);
  assert.equal(doc.hostVersion, null);
});

test('collectMetrics degrades, but still reports the host version, when nothing falls in the window', () => {
  // The file is fine and the host version is knowable — the work in it simply
  // belongs to an earlier Forge session. That distinction is the whole point
  // of a separate reason.
  const configDir = plantHost({
    lines: [
      assistantLine({
        requestId: 'req_x',
        at: '2026-07-27T09:00:00.000Z',
        version: '2.1.220',
        tokens: { output: 99 },
      }),
    ],
  });

  const doc = collectMetrics({
    session: boundSession({ createdAt: '2026-07-27T10:00:00.000Z' }),
    now: () => new Date('2026-07-27T11:00:00.000Z'),
    configDir,
  });

  assert.equal(doc.available, false);
  assert.match(doc.reason, /window/i);
  assert.equal(doc.hostVersion, '2.1.220');
});

const PHASES = [
  { phase: 'triage', at: '2026-07-27T10:00:00.000Z' },
  { phase: 'implement', at: '2026-07-27T10:20:00.000Z' },
  { phase: 'verify', at: '2026-07-27T10:40:00.000Z' },
];

test('collectMetrics attributes each request to the phase active at its timestamp', () => {
  const a = { input: 1, output: 10, cacheRead: 100, cacheCreate: 1 };
  const b = { input: 2, output: 20, cacheRead: 200, cacheCreate: 2 };
  const c = { input: 3, output: 30, cacheRead: 300, cacheCreate: 3 };
  const d = { input: 4, output: 40, cacheRead: 400, cacheCreate: 4 };
  const configDir = plantHost({
    lines: [
      assistantLine({ requestId: 'req_a', at: '2026-07-27T10:05:00.000Z', tokens: a }),
      // Exactly on a transition: the phase that just began owns it.
      assistantLine({ requestId: 'req_b', at: '2026-07-27T10:20:00.000Z', tokens: b }),
      assistantLine({ requestId: 'req_c', at: '2026-07-27T10:30:00.000Z', tokens: c }),
      assistantLine({ requestId: 'req_d', at: '2026-07-27T10:45:00.000Z', tokens: d }),
    ],
  });

  const doc = collectMetrics({
    session: boundSession({ phaseHistory: PHASES }),
    now: () => new Date('2026-07-27T11:00:00.000Z'),
    configDir,
  });

  assert.deepEqual(plain(doc.byPhase), {
    triage: { requests: 1, ...sumTokens(a) },
    implement: { requests: 2, ...sumTokens(b, c) },
    verify: { requests: 1, ...sumTokens(d) },
  });
});

test('collectMetrics files a request older than the first phase entry under the first phase', () => {
  // phaseHistory is seeded at createdAt now, so this is defensive — but a
  // session bound before that fix has a gap at the front, and dropping its
  // opening requests would quietly lose tokens.
  const early = { input: 7, output: 70, cacheRead: 700, cacheCreate: 7 };
  const later = { input: 8, output: 80, cacheRead: 800, cacheCreate: 8 };
  const configDir = plantHost({
    lines: [
      assistantLine({ requestId: 'req_early', at: '2026-07-27T10:05:00.000Z', tokens: early }),
      assistantLine({ requestId: 'req_later', at: '2026-07-27T10:45:00.000Z', tokens: later }),
    ],
  });

  const doc = collectMetrics({
    session: boundSession({
      phaseHistory: [
        { phase: 'implement', at: '2026-07-27T10:20:00.000Z' },
        { phase: 'verify', at: '2026-07-27T10:40:00.000Z' },
      ],
    }),
    now: () => new Date('2026-07-27T11:00:00.000Z'),
    configDir,
  });

  assert.deepEqual(plain(doc.byPhase), {
    implement: { requests: 1, ...sumTokens(early) },
    verify: { requests: 1, ...sumTokens(later) },
  });
  // Nothing was dropped on the way in.
  assert.equal(doc.byPhase.implement.requests + doc.byPhase.verify.requests, doc.requests);
});

test('collectMetrics attributes a subagent request to the phase it ran in', () => {
  // A reviewer subagent's tokens belong to the phase that dispatched it, not
  // to the coordinator's phase at collection time.
  const parent = { input: 1, output: 10, cacheRead: 100, cacheCreate: 1 };
  const child = { input: 9, output: 90, cacheRead: 900, cacheCreate: 9 };
  const configDir = plantHost({
    lines: [assistantLine({ requestId: 'req_p', at: '2026-07-27T10:25:00.000Z', tokens: parent })],
    subagents: {
      rev001: {
        meta: { agentType: 'general-purpose', model: 'opus', toolUseId: 'toolu_t', spawnDepth: 1 },
        lines: [
          sidecarLine('rev001', {
            requestId: 'req_s',
            at: '2026-07-27T10:50:00.000Z',
            tokens: child,
          }),
        ],
      },
    },
  });

  const doc = collectMetrics({
    session: boundSession({ phaseHistory: PHASES }),
    now: () => new Date('2026-07-27T11:00:00.000Z'),
    configDir,
  });

  assert.deepEqual(plain(doc.byPhase), {
    implement: { requests: 1, ...sumTokens(parent) },
    verify: { requests: 1, ...sumTokens(child) },
  });
});

test('collectMetrics accumulates a re-entered phase into one bucket', () => {
  // implement → verify → implement is an ordinary session shape. Keying the
  // table by position in the history instead of by phase name would report
  // two `implement` buckets and halve each of them.
  const first = { input: 1, output: 10, cacheRead: 100, cacheCreate: 1 };
  const middle = { input: 2, output: 20, cacheRead: 200, cacheCreate: 2 };
  const again = { input: 3, output: 30, cacheRead: 300, cacheCreate: 3 };
  const configDir = plantHost({
    lines: [
      assistantLine({ requestId: 'req_1', at: '2026-07-27T10:25:00.000Z', tokens: first }),
      assistantLine({ requestId: 'req_2', at: '2026-07-27T10:35:00.000Z', tokens: middle }),
      assistantLine({ requestId: 'req_3', at: '2026-07-27T10:45:00.000Z', tokens: again }),
    ],
  });

  const doc = collectMetrics({
    session: boundSession({
      phaseHistory: [
        { phase: 'implement', at: '2026-07-27T10:20:00.000Z' },
        { phase: 'verify', at: '2026-07-27T10:30:00.000Z' },
        { phase: 'implement', at: '2026-07-27T10:40:00.000Z' },
      ],
    }),
    now: () => new Date('2026-07-27T11:00:00.000Z'),
    configDir,
  });

  assert.deepEqual(plain(doc.byPhase), {
    implement: { requests: 2, ...sumTokens(first, again) },
    verify: { requests: 1, ...sumTokens(middle) },
  });
});

test('collectMetrics returns an empty byPhase when there is no usable timeline', () => {
  const configDir = plantHost({
    lines: [assistantLine({ requestId: 'req_1', at: '2026-07-27T10:25:00.000Z' })],
  });
  const histories = [
    [],
    undefined,
    null,
    'triage',
    [null, 42, {}],
    // Rows whose `at` cannot be parsed are dropped from the timeline; a
    // history made only of those leaves nothing to join against.
    [{ phase: 'implement', at: 'yesterday' }, { phase: 'verify' }],
  ];

  for (const phaseHistory of histories) {
    const doc = collectMetrics({
      session: boundSession({ phaseHistory }),
      now: () => new Date('2026-07-27T11:00:00.000Z'),
      configDir,
    });
    const label = JSON.stringify(phaseHistory) ?? 'undefined';
    assert.equal(doc.available, true, label);
    assert.deepEqual(plain(doc.byPhase), {}, label);
    // The document is otherwise real, so this is not passing on nothing.
    assert.equal(doc.requests, 1, label);
  }
});

test('collectMetrics degrades when the session has no parsable createdAt', () => {
  // With no window start there is no window, and billing a whole host
  // transcript to a session that cannot say when it began would over-count it
  // by however many Forge sessions came before.
  const configDir = plantHost({
    lines: [
      assistantLine({ requestId: 'req_1', at: '2026-07-27T09:00:00.000Z', tokens: { output: 5 } }),
      assistantLine({ requestId: 'req_2', at: '2026-07-27T10:25:00.000Z', tokens: { output: 5 } }),
    ],
  });

  for (const createdAt of [undefined, null, '', 42, 'the day before yesterday']) {
    const doc = collectMetrics({
      session: { id: 's', createdAt, host: { agent: 'claude-code', sessionIds: [HOST_ID] } },
      now: () => new Date('2026-07-27T11:00:00.000Z'),
      configDir,
    });
    const label = String(createdAt);
    assert.equal(doc.available, false, label);
    assert.match(doc.reason, /createdAt/i, label);
  }
});

test('collectMetrics returns a degraded document rather than throwing on hostile input', () => {
  const configDir = plantHost({
    lines: [assistantLine({ requestId: 'req_1', at: '2026-07-27T10:25:00.000Z' })],
  });
  const at = '2026-07-27T10:00:00.000Z';
  const hostile = [
    undefined,
    null,
    'a session',
    42,
    [],
    { host: null },
    { host: 'claude-code' },
    { host: [] },
    { host: { sessionIds: HOST_ID } },
    { host: { sessionIds: [null, 42, ''] } },
    { createdAt: at, host: { sessionIds: [HOST_ID] }, phaseHistory: 42 },
    { createdAt: at, host: { sessionIds: [HOST_ID] }, phaseHistory: [{ phase: 42, at: {} }] },
    { createdAt: {}, host: { sessionIds: [HOST_ID, HOST_ID] } },
  ];

  for (const session of hostile) {
    const label = JSON.stringify(session) ?? 'undefined';
    const doc = collectMetrics({ session, now: () => new Date(at), configDir });
    assert.equal(typeof doc.available, 'boolean', label);
    assert.equal(doc.collectedAt, at, label);
    if (doc.available === false) assert.equal(typeof doc.reason, 'string', label);
  }

  // …and with no options at all, or a `now` that blows up.
  for (const options of [undefined, null, 'nonsense', {}, { now: 'not a function' }]) {
    const doc = collectMetrics(options);
    assert.equal(doc.available, false, String(options));
    assert.equal(typeof doc.collectedAt, 'string', String(options));
  }
  const thrown = collectMetrics({
    session: { createdAt: at, host: { sessionIds: [HOST_ID] } },
    now: () => {
      throw new Error('clock is on fire');
    },
    configDir,
  });
  assert.equal(typeof thrown.available, 'boolean');
  assert.equal(typeof thrown.collectedAt, 'string');

  // A session object that throws when it is read at all. Nothing in the tree
  // does this today; the point is that the outer catch is load-bearing rather
  // than decoration, so an unforeseen throw still lets `forge phase done`
  // finish.
  const exploding = collectMetrics({
    session: {
      createdAt: at,
      get host() {
        throw new Error('session.json is cursed');
      },
    },
    now: () => new Date(at),
    configDir,
  });
  assert.equal(exploding.available, false);
  assert.match(exploding.reason, /session\.json is cursed/);
});

test('collectMetrics judges a request that straddles a window edge by its own in-window lines', () => {
  // The host writes one line per content block, and the first line of a
  // request carries a *preliminary* output count that a later line settles.
  // Filtering raw lines (not deduplicated requests) is what makes the two
  // edges behave differently, and both behaviours are deliberate:
  //
  //  - leading edge: a request begun just before the session and settled just
  //    inside it is counted, with the settled figure. Its work landed here.
  //  - trailing edge: a request still in flight at collection time keeps the
  //    preliminary figure, because its settled line is not written yet. The
  //    undercount is bounded to that one request, and the alternative — an
  //    open-ended window — would bill this session for the next one's work.
  const shared = { input: 10, cacheRead: 1000, cacheCreate: 5 };
  const configDir = plantHost({
    lines: [
      assistantLine({
        requestId: 'req_lead',
        at: '2026-07-27T09:59:59.000Z',
        tokens: { ...shared, output: 4 },
        block: { type: 'thinking' },
      }),
      assistantLine({
        requestId: 'req_lead',
        at: '2026-07-27T10:00:01.000Z',
        tokens: { ...shared, output: 200 },
      }),
      assistantLine({
        requestId: 'req_trail',
        at: '2026-07-27T10:29:59.000Z',
        tokens: { ...shared, output: 4 },
        block: { type: 'thinking' },
      }),
      assistantLine({
        requestId: 'req_trail',
        at: '2026-07-27T10:30:01.000Z',
        tokens: { ...shared, output: 300 },
      }),
    ],
  });

  const doc = collectMetrics({
    session: boundSession({
      createdAt: '2026-07-27T10:00:00.000Z',
      phaseHistory: [{ phase: 'implement', at: '2026-07-27T10:00:00.000Z' }],
    }),
    now: () => new Date('2026-07-27T10:30:00.000Z'),
    configDir,
  });

  assert.equal(doc.requests, 2);
  assert.deepEqual(doc.tokens, sumTokens({ ...shared, output: 200 }, { ...shared, output: 4 }));
  // Both belong to the phase that was running inside the window.
  assert.deepEqual(plain(doc.byPhase), {
    implement: { requests: 2, ...sumTokens({ ...shared, output: 200 }, { ...shared, output: 4 }) },
  });
});

test('collectMetrics lets no transcript content reach the document', () => {
  // The document is persisted and outlives the session, so the rule is counts,
  // model slugs, tool names, agent types, phase names and timestamps — never
  // prompt text, tool inputs, tool output or the free-form meta description.
  const secret = 'CANARY-a1b2c3';
  const configDir = plantHost({
    lines: [
      assistantLine({
        requestId: 'req_1',
        at: '2026-07-27T10:05:00.000Z',
        block: { type: 'text', text: `${secret} in the assistant's prose` },
      }),
      assistantLine({
        requestId: 'req_2',
        at: '2026-07-27T10:05:10.000Z',
        block: {
          type: 'tool_use',
          id: 'toolu_a',
          name: 'Bash',
          input: { command: `echo ${secret}` },
        },
      }),
      {
        type: 'user',
        timestamp: '2026-07-27T10:05:11.000Z',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_a', is_error: true, content: secret },
            { type: 'text', text: `the user typed ${secret}` },
          ],
        },
      },
    ],
    subagents: {
      sec001: {
        meta: {
          agentType: 'general-purpose',
          model: 'opus',
          description: `${secret} rotate the production credentials`,
        },
        lines: [
          sidecarLine('sec001', {
            requestId: 'req_s',
            at: '2026-07-27T10:06:00.000Z',
            block: { type: 'text', text: secret },
            tokens: { output: 3 },
          }),
        ],
      },
    },
  });

  const doc = collectMetrics({
    session: boundSession({ phaseHistory: PHASES }),
    now: () => new Date('2026-07-27T11:00:00.000Z'),
    configDir,
  });

  const serialised = JSON.stringify(doc);
  assert.equal(serialised.includes(secret), false);
  assert.equal(serialised.includes('description'), false);
  // …and the document is otherwise fully populated, so this is not passing on
  // an empty object.
  assert.equal(doc.available, true);
  assert.equal(doc.requests, 3);
  assert.equal(doc.subagents.length, 1);
  assert.deepEqual(plain(doc.tools), { Bash: { calls: 1, errors: 1 } });
});

/* ---------- the dispatch ledger ---------- */

/** A session directory holding `rows` as dispatches.jsonl. */
function sessionDirWith(rows) {
  const dir = tmp('forge-collect-dispatch-');
  if (rows !== null) {
    fs.writeFileSync(
      path.join(dir, 'dispatches.jsonl'),
      rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''),
      'utf8',
    );
  }
  return dir;
}

const DISPATCH_ROWS = [
  { decision: 'allow', modelRequested: 'opus', modelResolved: 'opus' },
  { decision: 'rewrite', modelRequested: 'sonnet', modelResolved: 'opus' },
  { decision: 'rewrite', modelRequested: 'haiku', modelResolved: 'opus' },
  { decision: 'deny', modelRequested: 'gpt-5', modelResolved: null },
];

test('the document carries how often the model policy had to correct a dispatch', () => {
  const configDir = plantHost({
    lines: [assistantLine({ requestId: 'req_1', at: '2026-07-27T10:30:00.000Z' })],
  });

  const doc = collectMetrics({
    session: boundSession(),
    sessionDir: sessionDirWith(DISPATCH_ROWS),
    now: () => new Date('2026-07-27T11:00:00.000Z'),
    configDir,
  });

  assert.equal(doc.available, true);
  assert.deepEqual(doc.dispatches, {
    total: 4,
    allowed: 1,
    rewritten: 2,
    denied: 1,
    skipped: 3,
  });
});

test('a session that dispatched nothing reports zeros, not an unavailable document', () => {
  const configDir = plantHost({
    lines: [assistantLine({ requestId: 'req_1', at: '2026-07-27T10:30:00.000Z' })],
  });

  for (const [label, dir] of [
    ['no dispatches.jsonl', sessionDirWith(null)],
    ['an empty dispatches.jsonl', sessionDirWith([])],
    ['no sessionDir at all', undefined],
  ]) {
    const doc = collectMetrics({
      session: boundSession(),
      sessionDir: dir,
      now: () => new Date('2026-07-27T11:00:00.000Z'),
      configDir,
    });
    assert.equal(doc.available, true, label);
    assert.deepEqual(doc.dispatches, EMPTY_DISPATCHES, label);
  }
});

test('dispatch counts survive a document that can say nothing else', () => {
  // The ledger is Forge's own file: a session with no host binding, or whose
  // transcript the host has pruned, still knows exactly what it dispatched.
  // Reporting that only when the transcripts happen to be readable would throw
  // away the one measurement that is still intact.
  const doc = collectMetrics({
    session: { id: 's1', createdAt: '2026-07-27T10:00:00.000Z', host: null },
    sessionDir: sessionDirWith(DISPATCH_ROWS),
    now: () => new Date('2026-07-27T11:00:00.000Z'),
    configDir: tmp('forge-collect-'),
  });

  assert.equal(doc.available, false);
  assert.match(doc.reason, /host session/i);
  assert.equal(doc.dispatches.skipped, 3, 'a rewrite and a denial both mean the resolver lost');
  assert.equal(doc.dispatches.total, 4);
});

test('an unreadable dispatch ledger costs the counts, not the document', () => {
  const dir = tmp('forge-collect-dispatch-bad-');
  fs.mkdirSync(path.join(dir, 'dispatches.jsonl'));
  const configDir = plantHost({
    lines: [assistantLine({ requestId: 'req_1', at: '2026-07-27T10:30:00.000Z' })],
  });

  const doc = collectMetrics({
    session: boundSession(),
    sessionDir: dir,
    now: () => new Date('2026-07-27T11:00:00.000Z'),
    configDir,
  });

  assert.equal(doc.available, true);
  assert.deepEqual(doc.dispatches, EMPTY_DISPATCHES);
});
