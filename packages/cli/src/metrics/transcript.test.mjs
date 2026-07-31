import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  aggregateTokens,
  aggregateTools,
  readJsonl,
  readSubagents,
  usageByRequest,
} from './transcript.mjs';

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

/** A `usage` object in the host's own field names. */
function usage({ input = 0, output = 0, cacheRead = 0, cacheCreate = 0 } = {}) {
  return {
    input_tokens: input,
    cache_creation_input_tokens: cacheCreate,
    cache_read_input_tokens: cacheRead,
    output_tokens: output,
    service_tier: 'standard',
    cache_creation: { ephemeral_1h_input_tokens: cacheCreate, ephemeral_5m_input_tokens: 0 },
  };
}

/**
 * One transcript line — i.e. one *content block* of an assistant reply, which
 * is the unit the host actually writes.
 */
function assistantLine({
  requestId,
  messageId,
  model = 'claude-fable-5',
  block = { type: 'text' },
  tokens = {},
  ...rest
} = {}) {
  const message = { model, content: [block], usage: usage(tokens) };
  if (messageId !== undefined) message.id = messageId;
  if (rest.usage === null) delete message.usage;
  delete rest.usage;
  const line = {
    type: 'assistant',
    timestamp: '2026-07-27T15:17:51.064Z',
    effort: 'xhigh',
    version: '2.1.220',
    isSidechain: false,
    ...rest,
    message,
  };
  if (requestId !== undefined) line.requestId = requestId;
  return line;
}

/** Write `body` to a fresh temp dir and return the file path. */
function transcriptFile(body) {
  return writeAt(path.join(tmp('forge-transcript-'), 'session.jsonl'), body);
}

function writeAt(file, body) {
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

/**
 * Copy a lookup table into an ordinary object so it can be compared to a
 * literal. `byModel`, `efforts` and `tools` are deliberately prototype-less —
 * their keys are host-supplied strings — and `deepStrictEqual` compares
 * prototypes, so a bare table never equals `{…}`. Spread is used rather than
 * `Object.assign` because it copies a `__proto__` key as an own property
 * instead of re-pointing the prototype.
 */
function plain(table) {
  return { ...table };
}

/** Run `body`, then strip anything it managed to write onto Object.prototype. */
function withCleanPrototype(body) {
  const keys = ['requests', 'input', 'output', 'cacheRead', 'cacheCreate', 'calls', 'errors'];
  try {
    body();
  } finally {
    for (const key of keys) delete Object.prototype[key];
  }
}

test('readJsonl parses every line of a clean file', () => {
  const file = transcriptFile('{"type":"user"}\n{"type":"assistant","requestId":"req_1"}\n');
  const result = readJsonl(file);
  assert.equal(result.error, null);
  assert.deepEqual(result.lines, [{ type: 'user' }, { type: 'assistant', requestId: 'req_1' }]);
});

test('readJsonl skips a corrupt line in the middle and keeps parsing later lines', () => {
  const file = transcriptFile('{"n":1}\nnot json at all\n{"n":2}\n');
  const result = readJsonl(file);
  assert.equal(result.error, null);
  assert.deepEqual(result.lines, [{ n: 1 }, { n: 2 }]);
});

test('readJsonl skips a truncated final line from a killed process', () => {
  const file = transcriptFile('{"n":1}\n{"n":2}\n{"n":3,"messa');
  const result = readJsonl(file);
  assert.equal(result.error, null);
  assert.deepEqual(result.lines, [{ n: 1 }, { n: 2 }]);
});

test('readJsonl ignores blank and whitespace-only lines', () => {
  const file = transcriptFile('\n{"n":1}\n   \n\n{"n":2}\n\n');
  const result = readJsonl(file);
  assert.equal(result.error, null);
  assert.deepEqual(result.lines, [{ n: 1 }, { n: 2 }]);
});

test('readJsonl returns an empty array for an empty file', () => {
  const result = readJsonl(transcriptFile(''));
  assert.equal(result.error, null);
  assert.deepEqual(result.lines, []);
});

test('readJsonl reports a missing file as ENOENT instead of throwing', () => {
  // Strictly more than this test asserted before the `{ lines, error }`
  // contract: a missing file is now a reported failure, not a silent [].
  const missing = path.join(tmp('forge-transcript-'), 'nope.jsonl');
  const result = readJsonl(missing);
  assert.equal(result.error.code, 'ENOENT');
  assert.deepEqual(result.lines, []);
});

test('readJsonl reports a directory path as EISDIR instead of throwing', () => {
  const result = readJsonl(tmp('forge-transcript-'));
  assert.equal(result.error.code, 'EISDIR');
  assert.deepEqual(result.lines, []);
});

// ---------------------------------------------------------------------------
// F56 — readJsonl is about to grow a `{ lines, error }` shape so a caller can
// tell a genuinely empty transcript apart from one whose content could not be
// read at all. Today it still collapses both into a bare `[]`, so every
// assertion below dies on the missing `.error`/`.lines` fields. Task 1.2
// translates the eight bare-array tests above to the new shape; these three
// pin the shape itself and must stay red until then.
// ---------------------------------------------------------------------------

test('readJsonl reports a content-unreadable file as a failure carrying the error code, not as an empty read', () => {
  // `chmod 000` on the *file* — its directory is left alone — is what
  // reproduces the gap `readJsonl` currently papers over: `fs.statSync` still
  // sees the file (it only reads the parent directory's entry) while
  // `fs.readFileSync` throws EACCES. Verified by two reviewers in the change
  // this test pins; confirmed again here via the guard below.
  const file = transcriptFile('{"n":1}\n');
  fs.chmodSync(file, 0o000);
  try {
    // Guard: prove the fixture is genuinely content-unreadable, or the
    // assertions below would pass for free.
    assert.throws(() => fs.readFileSync(file, 'utf8'), /EACCES/);

    const result = readJsonl(file);
    assert.equal(result.error.code, 'EACCES');
    assert.deepEqual(result.lines, []);
  } finally {
    // A stuck 000 fixture breaks every test that runs after this one in the
    // same file, so the mode is restored even if an assertion above throws.
    fs.chmodSync(file, 0o644);
  }
});

test('readJsonl reports a missing file as a failure with ENOENT — deliberately unlike the searching layer, where absence is routine', () => {
  // `readJsonl` reads a path `findTranscripts` (host.mjs) has just located, so
  // by the time this call runs, absence is a race against something that
  // deleted the file a moment ago — not the ordinary "nothing here" outcome
  // that the searching layer treats as unremarkable. See the delta spec,
  // session-metrics, first requirement: "unlike the locating layer... the
  // reading layer operates on a path that was just located, so absence there
  // is exceptional." A future edit must not "fix" this into host.mjs's policy.
  const missing = path.join(tmp('forge-transcript-'), 'nope.jsonl');
  const result = readJsonl(missing);
  assert.equal(result.error.code, 'ENOENT');
  assert.deepEqual(result.lines, []);
});

test('readJsonl reports no failure for a genuinely empty file — an empty read is a successful read of nothing', () => {
  const result = readJsonl(transcriptFile(''));
  assert.equal(result.error, null);
  assert.deepEqual(result.lines, []);
});

test('usageByRequest counts the usage of one reply once, not once per content block', () => {
  // The host emits one line per content block, repeating the whole usage object.
  const tokens = { input: 2, output: 621, cacheRead: 20606, cacheCreate: 9174 };
  const lines = [
    assistantLine({ requestId: 'req_1', block: { type: 'thinking' }, tokens }),
    assistantLine({ requestId: 'req_1', block: { type: 'text' }, tokens }),
    assistantLine({ requestId: 'req_1', block: { type: 'tool_use' }, tokens }),
  ];
  const entries = usageByRequest(lines);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].usage, {
    input: 2,
    output: 621,
    cacheRead: 20606,
    cacheCreate: 9174,
  });
});

test('usageByRequest normalises the host token field names', () => {
  const [entry] = usageByRequest([
    assistantLine({
      requestId: 'req_1',
      tokens: { input: 3, output: 4, cacheRead: 5, cacheCreate: 6 },
    }),
  ]);
  assert.deepEqual(entry.usage, { input: 3, output: 4, cacheRead: 5, cacheCreate: 6 });
});

test('usageByRequest defaults missing, non-numeric and negative token counts to zero', () => {
  const line = assistantLine({ requestId: 'req_1' });
  line.message.usage = {
    input_tokens: 'lots',
    output_tokens: -5,
    cache_creation_input_tokens: 7,
    // cache_read_input_tokens absent entirely
  };
  const [entry] = usageByRequest([line]);
  assert.deepEqual(entry.usage, { input: 0, output: 0, cacheRead: 0, cacheCreate: 7 });
});

test('usageByRequest ignores lines that are not assistant lines', () => {
  const lines = [
    { type: 'user', message: { usage: usage({ output: 999 }) } },
    { type: 'system', requestId: 'req_x' },
    { type: 'file-history-snapshot' },
    assistantLine({ requestId: 'req_1', tokens: { output: 5 } }),
  ];
  const entries = usageByRequest(lines);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].requestId, 'req_1');
});

test('usageByRequest ignores an assistant line carrying no usage object', () => {
  const lines = [
    assistantLine({ requestId: 'req_0', usage: null }),
    assistantLine({ requestId: 'req_1', tokens: { output: 5 } }),
  ];
  assert.deepEqual(
    usageByRequest(lines).map((e) => e.requestId),
    ['req_1'],
  );
});

test('usageByRequest falls back to message.id when requestId is absent', () => {
  const lines = [
    assistantLine({ messageId: 'msg_a', tokens: { output: 10 } }),
    assistantLine({ messageId: 'msg_a', tokens: { output: 10 } }),
  ];
  const entries = usageByRequest(lines);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].requestId, 'msg_a');
  assert.equal(entries[0].usage.output, 10);
});

test('usageByRequest counts a line with neither requestId nor message.id once each', () => {
  const lines = [
    assistantLine({ tokens: { output: 10 } }),
    assistantLine({ tokens: { output: 20 } }),
  ];
  const entries = usageByRequest(lines);
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((e) => e.usage.output),
    [10, 20],
  );
  assert.deepEqual(
    entries.map((e) => e.requestId),
    [null, null],
  );
});

test('usageByRequest preserves first-seen request order even when replies interleave', () => {
  const lines = [
    assistantLine({ requestId: 'req_b' }),
    assistantLine({ requestId: 'req_a' }),
    assistantLine({ requestId: 'req_b' }),
    assistantLine({ requestId: 'req_c' }),
    assistantLine({ requestId: 'req_a' }),
  ];
  assert.deepEqual(
    usageByRequest(lines).map((e) => e.requestId),
    ['req_b', 'req_a', 'req_c'],
  );
});

test('usageByRequest keeps an unidentified line in chronological position', () => {
  const lines = [
    assistantLine({ requestId: 'req_a', tokens: { output: 1 } }),
    assistantLine({ tokens: { output: 2 } }),
    assistantLine({ requestId: 'req_c', tokens: { output: 3 } }),
  ];
  assert.deepEqual(
    usageByRequest(lines).map((e) => e.usage.output),
    [1, 2, 3],
  );
});

test('usageByRequest takes the settled output count from the last line of a request, not the preliminary one from the first', () => {
  // The first line of a multi-line request carries a *preliminary* output
  // count — the host writes it before the reply has finished — and a later
  // line carries the settled figure. Copied from a real request:
  // req_011CdHbph3J3cZJVF9w1Qiz4 goes 4 → 131 while every other field holds
  // still. Taking the first line drops 28.6% of all output tokens measured
  // across this machine, and it understates every single time, so no total
  // built on it ever looks suspicious.
  const lines = [
    assistantLine({
      requestId: 'req_1',
      block: { type: 'thinking' },
      tokens: { input: 2, output: 4, cacheRead: 14544, cacheCreate: 17579 },
    }),
    assistantLine({
      requestId: 'req_1',
      block: { type: 'tool_use' },
      tokens: { input: 2, output: 131, cacheRead: 14544, cacheCreate: 17579 },
    }),
  ];
  const entries = usageByRequest(lines);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].usage, {
    input: 2,
    output: 131,
    cacheRead: 14544,
    cacheCreate: 17579,
  });
  assert.notEqual(entries[0].usage.output, 4);
});

test('usageByRequest keeps the settled output even when the request has many lines', () => {
  const lines = [3, 5, 40, 617].map((output, index) =>
    assistantLine({
      requestId: 'req_1',
      block: { type: index === 0 ? 'thinking' : 'text' },
      tokens: { output },
    }),
  );
  assert.equal(usageByRequest(lines)[0].usage.output, 617);
});

test('usageByRequest describes a request by its settled line, not its preliminary one', () => {
  // The scalars come from the same line as the usage, so one entry never
  // mixes facts from two lines. Measured over every transcript on this
  // machine, not one request disagrees with itself on any of these four, so
  // this rule is about keeping the record coherent rather than picking a
  // winner between rival values.
  const lines = [
    assistantLine({
      requestId: 'req_1',
      model: 'claude-opus-5',
      effort: 'xhigh',
      version: '2.1.220',
      isSidechain: true,
      timestamp: '2026-07-27T15:17:51.064Z',
      tokens: { output: 4 },
    }),
    assistantLine({
      requestId: 'req_1',
      model: 'claude-haiku-5',
      effort: 'low',
      version: '9.9.9',
      isSidechain: false,
      timestamp: '2026-07-27T15:18:00.000Z',
      tokens: { output: 131 },
    }),
  ];
  const entries = usageByRequest(lines);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    requestId: 'req_1',
    model: 'claude-haiku-5',
    // The exception: a request is placed in time by when it *started*, and
    // first-seen order is what the phase join reads.
    timestamp: '2026-07-27T15:17:51.064Z',
    effort: 'low',
    version: '9.9.9',
    isSidechain: false,
    usage: { input: 0, output: 131, cacheRead: 0, cacheCreate: 0 },
  });
});

test('usageByRequest carries no prompt, response or tool-input text into its entries', () => {
  const line = assistantLine({
    requestId: 'req_1',
    block: {
      type: 'tool_use',
      id: 'toolu_1',
      name: 'Bash',
      input: { command: 'cat /etc/PRIVATE-SECRET' },
    },
    tokens: { output: 5 },
  });
  line.message.content.push({ type: 'text', text: 'PRIVATE-SECRET response prose' });
  const serialised = JSON.stringify(usageByRequest([line]));
  assert.equal(serialised.includes('PRIVATE-SECRET'), false);
  assert.equal(serialised.includes('content'), false);
});

test('usageByRequest returns an empty array for junk input instead of throwing', () => {
  assert.deepEqual(usageByRequest([]), []);
  assert.deepEqual(usageByRequest(null), []);
  assert.deepEqual(usageByRequest('nope'), []);
  assert.deepEqual(usageByRequest([null, 42, 'x', {}]), []);
});

test('aggregateTokens sums the four token totals across requests', () => {
  const entries = usageByRequest([
    assistantLine({
      requestId: 'req_1',
      tokens: { input: 1, output: 10, cacheRead: 100, cacheCreate: 5 },
    }),
    assistantLine({
      requestId: 'req_2',
      tokens: { input: 2, output: 20, cacheRead: 200, cacheCreate: 6 },
    }),
  ]);
  const summary = aggregateTokens(entries);
  assert.equal(summary.requests, 2);
  assert.deepEqual(summary.tokens, { input: 3, output: 30, cacheRead: 300, cacheCreate: 11 });
});

test('aggregateTokens omits the host synthetic model from byModel but still counts its requests in totals', () => {
  const syntheticTokens = { input: 3, output: 30, cacheRead: 300, cacheCreate: 3 };
  const realTokens = { input: 1, output: 10, cacheRead: 100, cacheCreate: 1 };
  const entries = usageByRequest([
    assistantLine({
      requestId: 'req_synthetic',
      model: '<synthetic>',
      tokens: syntheticTokens,
    }),
    assistantLine({
      requestId: 'req_real',
      model: 'claude-opus-5',
      tokens: realTokens,
    }),
  ]);
  const summary = aggregateTokens(entries);
  const expectedTotal = {
    input: syntheticTokens.input + realTokens.input,
    output: syntheticTokens.output + realTokens.output,
    cacheRead: syntheticTokens.cacheRead + realTokens.cacheRead,
    cacheCreate: syntheticTokens.cacheCreate + realTokens.cacheCreate,
  };
  assert.equal(summary.requests, 2);
  assert.deepEqual(summary.tokens, expectedTotal);
  assert.equal(Object.hasOwn(summary.byModel, '<synthetic>'), false);
  assert.deepEqual(plain(summary.byModel), {
    'claude-opus-5': {
      requests: 1,
      input: realTokens.input,
      output: realTokens.output,
      cacheRead: realTokens.cacheRead,
      cacheCreate: realTokens.cacheCreate,
    },
  });
});

test('aggregateTokens splits totals by model slug', () => {
  const entries = usageByRequest([
    assistantLine({
      requestId: 'req_1',
      model: 'claude-opus-5',
      tokens: { input: 1, output: 10, cacheRead: 100, cacheCreate: 5 },
    }),
    assistantLine({
      requestId: 'req_2',
      model: 'claude-opus-5',
      tokens: { input: 2, output: 20, cacheRead: 200, cacheCreate: 6 },
    }),
    assistantLine({
      requestId: 'req_3',
      model: 'claude-fable-5',
      tokens: { input: 4, output: 40, cacheRead: 400, cacheCreate: 7 },
    }),
  ]);
  assert.deepEqual(plain(aggregateTokens(entries).byModel), {
    'claude-opus-5': { requests: 2, input: 3, output: 30, cacheRead: 300, cacheCreate: 11 },
    'claude-fable-5': { requests: 1, input: 4, output: 40, cacheRead: 400, cacheCreate: 7 },
  });
});

test('aggregateTokens files a request with no model under "unknown" rather than dropping it', () => {
  const line = assistantLine({ requestId: 'req_1', tokens: { output: 99 } });
  delete line.message.model;
  const summary = aggregateTokens(usageByRequest([line]));
  assert.equal(summary.requests, 1);
  assert.equal(summary.tokens.output, 99);
  assert.deepEqual(summary.byModel.unknown, {
    requests: 1,
    input: 0,
    output: 99,
    cacheRead: 0,
    cacheCreate: 0,
  });
});

test('aggregateTokens reports the most frequently observed host version', () => {
  const entries = usageByRequest([
    assistantLine({ requestId: 'req_1', version: '2.1.220' }),
    assistantLine({ requestId: 'req_2', version: '2.2.0' }),
    assistantLine({ requestId: 'req_3', version: '2.2.0' }),
  ]);
  assert.equal(aggregateTokens(entries).hostVersion, '2.2.0');
});

test('aggregateTokens tallies requests per effort and omits requests with none', () => {
  const noEffort = assistantLine({ requestId: 'req_4' });
  delete noEffort.effort;
  const entries = usageByRequest([
    assistantLine({ requestId: 'req_1', effort: 'xhigh' }),
    assistantLine({ requestId: 'req_2', effort: 'xhigh' }),
    assistantLine({ requestId: 'req_3', effort: 'high' }),
    noEffort,
  ]);
  const summary = aggregateTokens(entries);
  assert.equal(summary.requests, 4);
  assert.deepEqual(plain(summary.efforts), { xhigh: 2, high: 1 });
});

test('aggregateTokens returns a zero summary for empty or junk input, never null', () => {
  const zero = {
    requests: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    byModel: {},
    hostVersion: null,
    efforts: {},
  };
  const flat = (summary) => ({
    ...summary,
    byModel: plain(summary.byModel),
    efforts: plain(summary.efforts),
  });
  assert.deepEqual(flat(aggregateTokens([])), zero);
  assert.deepEqual(flat(aggregateTokens(null)), zero);
  assert.deepEqual(flat(aggregateTokens('nope')), zero);
  assert.deepEqual(flat(aggregateTokens([null, 7, {}])), zero);
});

test('aggregateTokens keeps a model slug of __proto__ in its own bucket and writes nothing to Object.prototype', () => {
  // `byModel[model] ??= {…}` never assigns for this key — `byModel.__proto__`
  // is already the prototype object — so the bucket silently vanishes and the
  // += lands on Object.prototype, giving every object in the process a
  // `requests` property and an `input` of NaN. A model slug is host-supplied
  // text, so the lookup table must not be an ordinary object.
  withCleanPrototype(() => {
    const summary = aggregateTokens(
      usageByRequest([
        assistantLine({ requestId: 'req_1', model: '__proto__', tokens: { output: 99 } }),
      ]),
    );
    assert.equal(summary.requests, 1);
    assert.equal(summary.tokens.output, 99);
    assert.deepEqual(Object.getOwnPropertyNames(summary.byModel), ['__proto__']);
    assert.deepEqual(Object.getOwnPropertyDescriptor(summary.byModel, '__proto__').value, {
      requests: 1,
      input: 0,
      output: 99,
      cacheRead: 0,
      cacheCreate: 0,
    });
    // Nothing leaked onto every object in the process.
    assert.equal(Object.hasOwn(Object.prototype, 'requests'), false);
    assert.equal({}.output, undefined);
  });
});

test('aggregateTokens tallies an effort of __proto__ without corrupting Object.prototype', () => {
  withCleanPrototype(() => {
    const summary = aggregateTokens(
      usageByRequest([assistantLine({ requestId: 'req_1', effort: '__proto__' })]),
    );
    assert.equal(Object.getOwnPropertyDescriptor(summary.efforts, '__proto__').value, 1);
    assert.equal(Object.getPrototypeOf({}), Object.prototype);
  });
});

test('aggregateTools counts tools named __proto__ and toString without corrupting Object.prototype', () => {
  // Same defect, same cause: `toString` is inherited and truthy, so `??=`
  // skips it too and the += mutates a function object. Any host-supplied key
  // that collides with Object.prototype hits this.
  withCleanPrototype(() => {
    const { tools, errors } = aggregateTools([
      toolUseLine({ requestId: 'req_1', id: 'toolu_1', name: '__proto__' }),
      toolResultLine({ id: 'toolu_1', isError: true }),
      toolUseLine({ requestId: 'req_2', id: 'toolu_2', name: 'toString' }),
      toolResultLine({ id: 'toolu_2', isError: false }),
    ]);
    assert.deepEqual(Object.getOwnPropertyNames(tools).sort(), ['__proto__', 'toString']);
    assert.deepEqual(Object.getOwnPropertyDescriptor(tools, '__proto__').value, {
      calls: 1,
      errors: 1,
    });
    assert.deepEqual(Object.getOwnPropertyDescriptor(tools, 'toString').value, {
      calls: 1,
      errors: 0,
    });
    assert.deepEqual(errors, { toolResults: 2, errorResults: 1, rate: 0.5 });
    assert.equal(Object.hasOwn(Object.prototype, 'calls'), false);
    assert.equal(typeof {}.toString, 'function');
  });
});

// ---------------------------------------------------------------------------
// The regression test this module exists for.
// ---------------------------------------------------------------------------

test('a 39-line transcript of 12 replies counts 12 requests, not 39 — usage is repeated on every content block', () => {
  // The host writes one transcript line per content block of a single
  // assistant reply, repeating the identical usage object on each. These are
  // the block counts of the 12 replies; they add up to 39 lines.
  const blocksPerReply = [1, 4, 4, 3, 2, 5, 1, 4, 3, 4, 4, 4];
  const blockTypes = ['thinking', 'text', 'tool_use', 'tool_use', 'tool_use'];

  const lines = [];
  blocksPerReply.forEach((blocks, index) => {
    const n = index + 1;
    // Reply n cost: 1 input, n*10 output, n*100 cache read, n*5 cache create.
    const tokens = { input: 1, output: n * 10, cacheRead: n * 100, cacheCreate: n * 5 };
    lines.push({ type: 'user', message: { role: 'user' } });
    for (let block = 0; block < blocks; block += 1) {
      lines.push(
        assistantLine({
          requestId: `req_${n}`,
          messageId: `msg_${n}`,
          model: 'claude-fable-5',
          block: { type: blockTypes[block] },
          // The first line of a multi-line reply carries the preliminary
          // output count the host writes before the reply has settled. Only
          // the last line of the reply carries the real one — so this fixture
          // catches truncation as well as inflation.
          tokens: block === 0 && blocks > 1 ? { ...tokens, output: 3 } : tokens,
        }),
      );
    }
    lines.push({ type: 'mode' }, { type: 'file-history-snapshot' });
  });

  const file = transcriptFile(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  const { lines: parsed, error } = readJsonl(file);
  assert.equal(error, null);
  // The fixture really is 39 assistant lines for 12 replies.
  assert.equal(parsed.filter((line) => line.type === 'assistant').length, 39);
  assert.equal(blocksPerReply.length, 12);

  const entries = usageByRequest(parsed);
  assert.equal(entries.length, 12);

  const summary = aggregateTokens(entries);
  assert.equal(summary.requests, 12);
  // Sum over the 12 distinct requests: 1+2+…+12 = 78 reply-units.
  assert.deepEqual(summary.tokens, { input: 12, output: 780, cacheRead: 7800, cacheCreate: 390 });
  // What summing all 39 lines would have produced — plausible-looking, wrong.
  // Derived from the fixture, not quoted: this guard was written by hand as
  // 2710, then silently went vacuous when the fixture gained its preliminary
  // output counts and the real sum became 2040. A guard naming a number no
  // implementation can produce cannot fail, and reads as protection.
  const summingEveryLine = parsed
    .filter((line) => line.type === 'assistant')
    .reduce(
      (total, line) => ({
        input: total.input + line.message.usage.input_tokens,
        output: total.output + line.message.usage.output_tokens,
        cacheRead: total.cacheRead + line.message.usage.cache_read_input_tokens,
        cacheCreate: total.cacheCreate + line.message.usage.cache_creation_input_tokens,
      }),
      { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    );
  // Pinned so the fixture's shape stays visible, and so a future edit to the
  // fixture fails here loudly instead of quietly disarming the guard below.
  assert.deepEqual(summingEveryLine, {
    input: 39,
    output: 2040,
    cacheRead: 27100,
    cacheCreate: 1355,
  });
  assert.notDeepEqual(summary.tokens, summingEveryLine);
  // And the other direction. Ten of the twelve replies span several lines, so
  // reading each reply's *first* line yields 10 + 70 (the two single-line
  // replies, which have no preliminary count) + 3*10 = 110: an 86% undercount.
  // Inflation and truncation both look plausible in a total; only a fixture
  // whose lines disagree can tell them apart.
  assert.notEqual(summary.tokens.output, 110);
  assert.deepEqual(plain(summary.byModel), {
    'claude-fable-5': { requests: 12, input: 12, output: 780, cacheRead: 7800, cacheCreate: 390 },
  });
  assert.equal(summary.hostVersion, '2.1.220');
  assert.deepEqual(plain(summary.efforts), { xhigh: 12 });
});

// ---------------------------------------------------------------------------
// aggregateTools
// ---------------------------------------------------------------------------

/** An assistant line whose single content block is a tool call. */
function toolUseLine({ requestId, id, name, input = { command: 'true' } }) {
  return assistantLine({ requestId, block: { type: 'tool_use', id, name, input } });
}

/**
 * A user line carrying tool results — the shape the host writes them in.
 * `is_error` is omitted entirely when not passed, which is what the host does
 * for most results.
 */
function toolResultLine(...results) {
  return {
    type: 'user',
    timestamp: '2026-07-27T15:17:52.000Z',
    isSidechain: false,
    message: {
      role: 'user',
      content: results.map(({ id, isError, content = 'output text' }) => {
        const block = { type: 'tool_result', tool_use_id: id, content };
        if (isError !== undefined) block.is_error = isError;
        return block;
      }),
    },
  };
}

test('aggregateTools counts calls per tool name and attributes each error to its own tool', () => {
  const lines = [
    toolUseLine({ requestId: 'req_1', id: 'toolu_1', name: 'Bash' }),
    toolResultLine({ id: 'toolu_1', isError: true }),
    toolUseLine({ requestId: 'req_2', id: 'toolu_2', name: 'Bash' }),
    toolResultLine({ id: 'toolu_2', isError: false }),
    toolUseLine({ requestId: 'req_3', id: 'toolu_3', name: 'Read' }),
    toolResultLine({ id: 'toolu_3', isError: false }),
    toolUseLine({ requestId: 'req_4', id: 'toolu_4', name: 'Read' }),
    toolResultLine({ id: 'toolu_4', isError: false }),
  ];
  const { tools, errors } = aggregateTools(lines);
  assert.deepEqual(plain(tools), {
    Bash: { calls: 2, errors: 1 },
    Read: { calls: 2, errors: 0 },
  });
  assert.deepEqual(errors, { toolResults: 4, errorResults: 1, rate: 0.25 });
});

test('aggregateTools treats is_error false, null and absent alike as successes', () => {
  // Measured across every transcript on this machine: 23780 false, 22812
  // absent, 824 true. Counting anything but an explicit true as a failure
  // would report roughly half of all tool calls as failing.
  const lines = [
    toolUseLine({ requestId: 'req_1', id: 'toolu_1', name: 'Bash' }),
    toolUseLine({ requestId: 'req_2', id: 'toolu_2', name: 'Bash' }),
    toolUseLine({ requestId: 'req_3', id: 'toolu_3', name: 'Bash' }),
    toolResultLine({ id: 'toolu_1', isError: false }),
    toolResultLine({ id: 'toolu_2', isError: null }),
    toolResultLine({ id: 'toolu_3' }), // no is_error key at all
  ];
  const { tools, errors } = aggregateTools(lines);
  assert.deepEqual(plain(tools), { Bash: { calls: 3, errors: 0 } });
  assert.deepEqual(errors, { toolResults: 3, errorResults: 0, rate: 0 });
});

test('aggregateTools reports a rate of 0, never NaN, when there are no tool results', () => {
  // 0/0 is NaN, JSON.stringify writes it as null, and every downstream average
  // built on it silently becomes NaN too.
  const { tools, errors } = aggregateTools([
    toolUseLine({ requestId: 'req_1', id: 'toolu_1', name: 'Bash' }),
  ]);
  assert.deepEqual(plain(tools), { Bash: { calls: 1, errors: 0 } });
  assert.deepEqual(errors, { toolResults: 1 - 1, errorResults: 0, rate: 0 });
  assert.equal(Number.isNaN(errors.rate), false);
  assert.equal(JSON.parse(JSON.stringify(errors)).rate, 0);
});

test('aggregateTools counts a tool_result whose call it never saw without inventing a tool', () => {
  // A session resumed mid-flight starts its transcript after the call that the
  // first result answers. It still cost a round trip, so it counts in the
  // totals; it belongs to no tool, so no bucket is invented for it.
  const lines = [
    toolUseLine({ requestId: 'req_1', id: 'toolu_1', name: 'Bash' }),
    toolResultLine({ id: 'toolu_1', isError: false }),
    toolResultLine({ id: 'toolu_from_a_previous_session', isError: true }),
  ];
  const { tools, errors } = aggregateTools(lines);
  assert.deepEqual(plain(tools), { Bash: { calls: 1, errors: 0 } });
  assert.deepEqual(errors, { toolResults: 2, errorResults: 1, rate: 0.5 });
});

test('aggregateTools counts one tool_use block repeated across lines of a request once', () => {
  // Same trap as usageByRequest: the host writes one line per content block and
  // may restate a block on more than one line of the same request. The block's
  // own id is unique per call, so it — not the block count — is the unit.
  const lines = [
    assistantLine({ requestId: 'req_1', block: { type: 'thinking' } }),
    toolUseLine({ requestId: 'req_1', id: 'toolu_1', name: 'Bash' }),
    toolUseLine({ requestId: 'req_1', id: 'toolu_1', name: 'Bash' }),
    toolUseLine({ requestId: 'req_1', id: 'toolu_1', name: 'Bash' }),
    toolResultLine({ id: 'toolu_1', isError: true }),
  ];
  const { tools, errors } = aggregateTools(lines);
  assert.deepEqual(plain(tools), { Bash: { calls: 1, errors: 1 } });
  assert.deepEqual(errors, { toolResults: 1, errorResults: 1, rate: 1 });
});

test('aggregateTools counts two distinct calls to one tool separately', () => {
  // The other half of the dedupe: two ids are two calls even in one request.
  const lines = [
    toolUseLine({ requestId: 'req_1', id: 'toolu_1', name: 'Bash' }),
    toolUseLine({ requestId: 'req_1', id: 'toolu_2', name: 'Bash' }),
  ];
  assert.deepEqual(plain(aggregateTools(lines).tools), { Bash: { calls: 2, errors: 0 } });
});

test('aggregateTools files a tool_use block carrying no name under "unknown"', () => {
  const nameless = toolUseLine({ requestId: 'req_1', id: 'toolu_1', name: 'Bash' });
  delete nameless.message.content[0].name;
  const { tools } = aggregateTools([nameless, toolResultLine({ id: 'toolu_1', isError: true })]);
  assert.deepEqual(plain(tools), { unknown: { calls: 1, errors: 1 } });
});

test('aggregateTools returns a zero summary for empty or junk input instead of throwing', () => {
  const zero = { tools: {}, errors: { toolResults: 0, errorResults: 0, rate: 0 } };
  const flat = (result) => ({ ...result, tools: plain(result.tools) });
  assert.deepEqual(flat(aggregateTools([])), zero);
  assert.deepEqual(flat(aggregateTools(null)), zero);
  assert.deepEqual(flat(aggregateTools(undefined)), zero);
  assert.deepEqual(flat(aggregateTools('nope')), zero);
  assert.deepEqual(
    flat(aggregateTools([null, 42, 'x', {}, { message: { content: 'text' } }])),
    zero,
  );
  assert.deepEqual(
    flat(aggregateTools([{ type: 'assistant', message: { content: [null, 7] } }])),
    zero,
  );
});

test('aggregateTools carries no command string or tool output into its counts', () => {
  const lines = [
    toolUseLine({
      requestId: 'req_1',
      id: 'toolu_1',
      name: 'Bash',
      input: { command: 'cat /etc/PRIVATE-SECRET', description: 'PRIVATE-SECRET' },
    }),
    toolResultLine({ id: 'toolu_1', isError: true, content: 'PRIVATE-SECRET file contents' }),
  ];
  const serialised = JSON.stringify(aggregateTools(lines));
  assert.equal(serialised.includes('PRIVATE-SECRET'), false);
  assert.equal(serialised.includes('content'), false);
  // The tool name is the one string that is allowed through.
  assert.equal(serialised.includes('Bash'), true);
});

// ---------------------------------------------------------------------------
// readSubagents
// ---------------------------------------------------------------------------

/**
 * Write one `agent-<id>.jsonl` / `agent-<id>.meta.json` pair into `dir`.
 * Either half may be omitted; `meta` given as a string is written verbatim, so
 * a test can plant malformed JSON.
 */
function writeSubagent(dir, agentId, { meta, lines } = {}) {
  if (meta !== undefined) {
    writeAt(
      path.join(dir, `agent-${agentId}.meta.json`),
      typeof meta === 'string' ? meta : JSON.stringify(meta),
    );
  }
  if (lines !== undefined) {
    writeAt(
      path.join(dir, `agent-${agentId}.jsonl`),
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    );
  }
  return dir;
}

/** A sidecar assistant line: sidechain, own agentId, the *parent's* sessionId. */
function sidecarLine(agentId, options) {
  return assistantLine({
    isSidechain: true,
    agentId,
    sessionId: '86e5cb59-40ae-4271-b8ee-fcde6fb23401',
    ...options,
  });
}

test('readSubagents pairs a sidecar transcript with its meta into one record', () => {
  const dir = tmp('forge-subagents-');
  writeSubagent(dir, 'a4dfd646d331fdddb', {
    meta: {
      agentType: 'general-purpose',
      description: 'Final implementation review',
      toolUseId: 'toolu_01FDBPbxNCa2gjZEGnRx3rzf',
      spawnDepth: 1,
      model: 'opus',
    },
    lines: [
      // Two requests, the first restated across two content-block lines.
      sidecarLine('a4dfd646d331fdddb', {
        requestId: 'req_1',
        model: 'claude-opus-5',
        block: { type: 'thinking' },
        tokens: { input: 1, output: 10, cacheRead: 100, cacheCreate: 5 },
      }),
      sidecarLine('a4dfd646d331fdddb', {
        requestId: 'req_1',
        model: 'claude-opus-5',
        block: { type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { command: 'true' } },
        tokens: { input: 1, output: 10, cacheRead: 100, cacheCreate: 5 },
      }),
      toolResultLine({ id: 'toolu_a', isError: true }),
      sidecarLine('a4dfd646d331fdddb', {
        requestId: 'req_2',
        model: 'claude-opus-5',
        tokens: { input: 2, output: 20, cacheRead: 200, cacheCreate: 6 },
      }),
    ],
  });

  assert.deepEqual(readSubagents(dir), [
    {
      agentId: 'a4dfd646d331fdddb',
      agentType: 'general-purpose',
      // The alias it was dispatched under vs the slug that actually answered —
      // comparing the two is how model policy gets audited.
      modelDispatched: 'opus',
      modelResolved: 'claude-opus-5',
      toolUseId: 'toolu_01FDBPbxNCa2gjZEGnRx3rzf',
      spawnDepth: 1,
      requests: 2,
      tokens: { input: 3, output: 30, cacheRead: 300, cacheCreate: 11 },
      errors: { toolResults: 1, errorResults: 1, rate: 1 },
    },
  ]);
});

test('readSubagents reports a meta with no transcript as a dispatch that produced nothing', () => {
  // The subagent was dispatched — the meta proves it — and either never wrote
  // a line or had its transcript pruned. Dropping it would silently undercount
  // the fleet.
  const dir = tmp('forge-subagents-');
  writeSubagent(dir, 'a1111111111111111', {
    meta: { agentType: 'Explore', toolUseId: 'toolu_x', spawnDepth: 2, model: 'haiku' },
  });
  assert.deepEqual(readSubagents(dir), [
    {
      agentId: 'a1111111111111111',
      agentType: 'Explore',
      modelDispatched: 'haiku',
      modelResolved: null,
      toolUseId: 'toolu_x',
      spawnDepth: 2,
      requests: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
      errors: { toolResults: 0, errorResults: 0, rate: 0 },
    },
  ]);
});

test('readSubagents counts a transcript whose meta is missing, with null metadata', () => {
  const dir = tmp('forge-subagents-');
  writeSubagent(dir, 'a2222222222222222', {
    lines: [
      sidecarLine('a2222222222222222', {
        requestId: 'req_1',
        model: 'claude-sonnet-5',
        tokens: { output: 42 },
      }),
    ],
  });
  assert.deepEqual(readSubagents(dir), [
    {
      agentId: 'a2222222222222222',
      agentType: null,
      modelDispatched: null,
      modelResolved: 'claude-sonnet-5',
      toolUseId: null,
      spawnDepth: null,
      requests: 1,
      tokens: { input: 0, output: 42, cacheRead: 0, cacheCreate: 0 },
      errors: { toolResults: 0, errorResults: 0, rate: 0 },
    },
  ]);
});

test('readSubagents keeps counting a transcript whose meta JSON is malformed', () => {
  const dir = tmp('forge-subagents-');
  writeSubagent(dir, 'a3333333333333333', {
    meta: '{"agentType":"general-purpose","model":"opu',
    lines: [
      sidecarLine('a3333333333333333', {
        requestId: 'req_1',
        model: 'claude-opus-5',
        tokens: { output: 7 },
      }),
    ],
  });
  const [record] = readSubagents(dir);
  assert.equal(record.agentId, 'a3333333333333333');
  assert.equal(record.agentType, null);
  assert.equal(record.modelDispatched, null);
  assert.equal(record.modelResolved, 'claude-opus-5');
  assert.equal(record.requests, 1);
  assert.equal(record.tokens.output, 7);
});

test('readSubagents tolerates a meta file whose JSON parses to something that is not an object', () => {
  // `null` is the one that bites: it parses cleanly, so a try/catch around
  // JSON.parse does not catch it, and reading a field off it throws.
  for (const meta of ['null', '"a string"', '[1,2,3]', '42']) {
    const dir = tmp('forge-subagents-');
    writeSubagent(dir, 'a5555555555555555', {
      meta,
      lines: [
        sidecarLine('a5555555555555555', {
          requestId: 'req_1',
          model: 'claude-opus-5',
          tokens: { output: 11 },
        }),
      ],
    });
    const [record] = readSubagents(dir);
    assert.equal(record.agentType, null, `meta ${meta}`);
    assert.equal(record.modelDispatched, null, `meta ${meta}`);
    assert.equal(record.spawnDepth, null, `meta ${meta}`);
    // The transcript beside it still counts.
    assert.equal(record.requests, 1, `meta ${meta}`);
    assert.equal(record.tokens.output, 11, `meta ${meta}`);
  }
});

test('readSubagents returns an empty array for a null, missing or non-directory path', () => {
  assert.deepEqual(readSubagents(null), []);
  assert.deepEqual(readSubagents(undefined), []);
  assert.deepEqual(readSubagents(''), []);
  assert.deepEqual(readSubagents(path.join(tmp('forge-subagents-'), 'no-such-dir')), []);
  assert.deepEqual(readSubagents(transcriptFile('{"n":1}\n')), []); // a file, not a dir
  assert.deepEqual(readSubagents(tmp('forge-subagents-')), []); // empty dir
});

test('readSubagents returns records sorted by agentId, not in filesystem order', () => {
  // A contract guard, not a driver: `readdirSync` happens to return these
  // names already sorted on the filesystem this suite runs on, so this test
  // cannot fail here even with the sort removed — verified by removing it.
  // It pins the guarantee for filesystems that return hash or insertion
  // order, where a persisted metrics file would otherwise churn between runs.
  const dir = tmp('forge-subagents-');
  const ids = ['a90', 'a10', 'a50', 'a70', 'a30', 'a20'];
  for (const id of ids) writeSubagent(dir, id, { meta: { agentType: 'general-purpose' } });
  assert.deepEqual(
    readSubagents(dir).map((r) => r.agentId),
    ['a10', 'a20', 'a30', 'a50', 'a70', 'a90'],
  );
});

test('readSubagents never lets the free-form meta description reach a record', () => {
  // This output is persisted to a file that outlives the session; description
  // is user prose and agentType answers the same question.
  const dir = tmp('forge-subagents-');
  writeSubagent(dir, 'a4444444444444444', {
    meta: {
      agentType: 'general-purpose',
      description: 'PRIVATE-SECRET rotate the production credentials',
      toolUseId: 'toolu_y',
      spawnDepth: 1,
      model: 'opus',
    },
    lines: [sidecarLine('a4444444444444444', { requestId: 'req_1', model: 'claude-opus-5' })],
  });

  const records = readSubagents(dir);
  const serialised = JSON.stringify(records);
  assert.equal(serialised.includes('PRIVATE-SECRET'), false);
  assert.equal(serialised.includes('description'), false);
  assert.equal(Object.hasOwn(records[0], 'description'), false);
  // The record is otherwise populated, so this is not passing on an empty one.
  assert.equal(records[0].agentType, 'general-purpose');
  assert.equal(records[0].requests, 1);
});
