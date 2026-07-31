import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { readReviewerSidecars, reviewEvidence } from './review-evidence.mjs';

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
  };
}

/** One assistant transcript line — i.e. one content block of one reply. */
function assistantLine({ requestId, at, model = 'claude-opus-5', tokens = {} } = {}) {
  return {
    type: 'assistant',
    requestId,
    timestamp: at,
    isSidechain: true,
    message: { id: `msg_${requestId}`, model, content: [{ type: 'text' }], usage: usage(tokens) },
  };
}

function jsonl(lines) {
  return lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n');
}

/** A meta in the host's own shape; `stoppedByUser` is absent unless asked for. */
function meta({ description, stoppedByUser } = {}) {
  const out = {
    agentType: 'general-purpose',
    description,
    toolUseId: 'toolu_017uFdNuuRF9FFhJk8oz15Gr',
    spawnDepth: 1,
    model: 'opus',
  };
  if (stoppedByUser !== undefined) out.stoppedByUser = stoppedByUser;
  return out;
}

/**
 * Lay out `agent-<id>.meta.json` / `agent-<id>.jsonl` pairs in a fresh dir,
 * exactly as the host writes them. Omit either half to model a killed or
 * pruned dispatch.
 */
function plantSidecars(agents, dir = tmp('forge-review-evidence-')) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [agentId, { meta: agentMeta, lines }] of Object.entries(agents)) {
    if (agentMeta !== undefined) {
      fs.writeFileSync(
        path.join(dir, `agent-${agentId}.meta.json`),
        typeof agentMeta === 'string' ? agentMeta : JSON.stringify(agentMeta),
      );
    }
    if (lines !== undefined) {
      fs.writeFileSync(path.join(dir, `agent-${agentId}.jsonl`), jsonl(lines));
    }
  }
  return dir;
}

test('readReviewerSidecars returns one record per dispatch carrying the prescribed token', () => {
  const dir = plantSidecars({
    a1: {
      meta: meta({ description: 'forge-review final' }),
      lines: [assistantLine({ requestId: 'req_1', at: '2026-07-28T10:00:00.000Z' })],
    },
  });

  const records = readReviewerSidecars(dir);
  assert.equal(records.length, 1);
  assert.equal(records[0].agentId, 'a1');
  assert.equal(records[0].unit, 'final');
});

test('readReviewerSidecars counts requests, not transcript lines', () => {
  // `req_1` is restated across two lines — one content block each — exactly as
  // the host writes a reply that thinks and then speaks. Counting lines would
  // report 3; the dedupe `usageByRequest` owns reports 2.
  const lines = [
    assistantLine({ requestId: 'req_1', at: '2026-07-28T10:00:00.000Z', tokens: { output: 4 } }),
    assistantLine({ requestId: 'req_1', at: '2026-07-28T10:00:01.000Z', tokens: { output: 131 } }),
    assistantLine({ requestId: 'req_2', at: '2026-07-28T10:00:02.000Z', tokens: { output: 12 } }),
  ];
  const expected = new Set(lines.map((line) => line.requestId)).size;
  // The fixture only discriminates if the two counts genuinely differ.
  assert.notEqual(expected, lines.length);

  const dir = plantSidecars({ a1: { meta: meta({ description: 'forge-review final' }), lines } });

  assert.equal(readReviewerSidecars(dir)[0].requests, expected);
});

test('readReviewerSidecars carries the host record of an operator stopping a dispatch', () => {
  // Measured on this machine (corpus count lives in review-census.mjs): `stoppedByUser`
  // is written only as literal `true`, on 5 of them, and is absent — not
  // `false` — on every other.
  const dir = plantSidecars({
    a1: {
      meta: meta({ description: 'forge-review final', stoppedByUser: true }),
      lines: [assistantLine({ requestId: 'req_1', at: '2026-07-28T10:00:00.000Z' })],
    },
    a2: {
      meta: meta({ description: 'forge-review group-03-collector' }),
      lines: [assistantLine({ requestId: 'req_2', at: '2026-07-28T10:00:00.000Z' })],
    },
  });

  const byId = Object.fromEntries(readReviewerSidecars(dir).map((r) => [r.agentId, r]));
  assert.equal(byId.a1.stoppedByUser, true);
  // Absent must read as false, and as a boolean — not `undefined`.
  assert.equal(byId.a2.stoppedByUser, false);
});

test('readReviewerSidecars keeps a stopped dispatch that never wrote a transcript', () => {
  // A pruned `.jsonl` beside a surviving meta. NOT what a declined dispatch
  // looks like — an earlier version of this comment claimed that and it is
  // refuted: measured over every sidecar meta on this machine
  // (2026-07-28), 0 lack a transcript, and all five carrying `stoppedByUser`
  // have transcripts of 49-423 lines, because an operator stops a dispatch
  // after it has started.
  //
  // The record is kept regardless: dropping it would report "no reviewer was
  // dispatched" for a reviewer that demonstrably was — the collapse of absence
  // into a negative that this change exists to stop. `reviewEvidence` cannot
  // place it in a window and so reports unavailable; this reader has no window
  // to judge it against and so reports what it found.
  const dir = plantSidecars({
    a1: { meta: meta({ description: 'forge-review final', stoppedByUser: true }) },
  });

  const records = readReviewerSidecars(dir);
  assert.equal(records.length, 1);
  assert.equal(records[0].unit, 'final');
  assert.equal(records[0].stoppedByUser, true);
  assert.equal(records[0].requests, 0);
  assert.equal(records[0].at, null);
});

test('readReviewerSidecars stamps a dispatch with its earliest parsable line', () => {
  const lines = [
    assistantLine({ requestId: 'req_2', at: '2026-07-28T10:05:00.000Z' }),
    { type: 'user', timestamp: 'not-a-date', message: { content: [] } },
    // Earliest, and neither first in the file nor an assistant line: a
    // first-line-wins or assistant-only reader lands on a later stamp.
    { type: 'user', timestamp: '2026-07-28T09:59:30.000Z', message: { content: [] } },
    assistantLine({ requestId: 'req_1', at: '2026-07-28T10:00:00.000Z' }),
    { type: 'summary' },
  ];
  const expected = lines
    .map((line) => line.timestamp)
    .filter((at) => typeof at === 'string' && !Number.isNaN(Date.parse(at)))
    .reduce((earliest, at) => (Date.parse(at) < Date.parse(earliest) ? at : earliest));
  assert.notEqual(expected, lines[0].timestamp);

  const dir = plantSidecars({ a1: { meta: meta({ description: 'forge-review final' }), lines } });

  assert.equal(readReviewerSidecars(dir)[0].at, expected);
});

test('readReviewerSidecars applies an optional line filter before counting', () => {
  const lines = [
    assistantLine({ requestId: 'req_1', at: '2026-07-28T09:00:00.000Z' }),
    assistantLine({ requestId: 'req_2', at: '2026-07-28T11:00:00.000Z' }),
    assistantLine({ requestId: 'req_3', at: '2026-07-28T12:00:00.000Z' }),
  ];
  const cutoff = Date.parse('2026-07-28T10:00:00.000Z');
  const keep = (line) => Date.parse(line.timestamp) >= cutoff;
  const kept = lines.filter(keep);
  const expected = new Set(kept.map((line) => line.requestId)).size;
  // The filter only proves anything if it actually discards something.
  assert.notEqual(expected, new Set(lines.map((line) => line.requestId)).size);

  const dir = plantSidecars({ a1: { meta: meta({ description: 'forge-review final' }), lines } });

  const record = readReviewerSidecars(dir, { filter: keep })[0];
  assert.equal(record.requests, expected);
  assert.equal(record.at, kept[0].timestamp);
});

test('readReviewerSidecars keeps a record whose every line the filter discards', () => {
  // Same contract as `readSubagents`: a dispatch that survives the filter with
  // nothing left is still a dispatch, reported with zero counts.
  const dir = plantSidecars({
    a1: {
      meta: meta({ description: 'forge-review final' }),
      lines: [assistantLine({ requestId: 'req_1', at: '2026-07-28T09:00:00.000Z' })],
    },
  });

  const records = readReviewerSidecars(dir, { filter: () => false });
  assert.equal(records.length, 1);
  assert.equal(records[0].requests, 0);
  assert.equal(records[0].at, null);
});

test('readReviewerSidecars ignores a dispatch whose description carries no prescribed token', () => {
  // Every one of these is a plausible real review dispatch written by hand.
  // None is the prescribed token, so none is evidence: this reader answers
  // "was a reviewer dispatched for unit X", and a description it cannot parse
  // a unit out of cannot answer that question for any unit.
  const adHoc = [
    'Group 2 review: transcript reader',
    'Adversarial review of group 7',
    'Final review of phase-2a change',
    'forge-reviewer for the final phase',
    'review',
    // Measured over-credits, both from this change's own session: an
    // *implementer* dispatch described `forge-review implement group 1`
    // produced a review record under substring matching, and the prose below
    // yielded a unit of `implementation`. The token is now matched exactly.
    'forge-review implement group 1',
    'talk about forge-review implementation details',
    'forge-review final, then group 7',
    // Trailing text, killed by the `$` anchor...
    'Dispatch forge-review final now',
    // ...and leading text, killed by the `^` anchor. Both edges are pinned.
    'Please run forge-review final',
  ];
  const agents = {};
  for (const [index, description] of adHoc.entries()) {
    agents[`a${index}`] = {
      meta: meta({ description }),
      lines: [assistantLine({ requestId: `req_${index}`, at: '2026-07-28T10:00:00.000Z' })],
    };
  }

  assert.deepEqual(readReviewerSidecars(plantSidecars(agents)), []);
});

test('readReviewerSidecars matches the token case-insensitively and normalises the unit', () => {
  const dir = plantSidecars({
    a1: { meta: meta({ description: '  FORGE-REVIEW Group-03-Collector  ' }) },
  });

  const records = readReviewerSidecars(dir);
  assert.equal(records.length, 1);
  // Lower-cased, or a caller looking up `units['group-03-collector']` reads
  // "no reviewer ran" off a reviewer that did. Surrounding whitespace is
  // trimmed, so a hand-typed description with a trailing newline still counts.
  assert.equal(records[0].unit, 'group-03-collector');
});

test('readReviewerSidecars refuses a unit longer than a prescribed unit can be', () => {
  // The unit is persisted, so its length is bounded. Past the cap the
  // description is not a prescribed dispatch at all, and falls back to prose
  // rather than writing an unbounded string into the digest.
  const long = 'g'.repeat(200);
  const dir = plantSidecars({
    a1: { meta: meta({ description: `forge-review ${long}` }) },
    a2: { meta: meta({ description: 'forge-review final' }) },
  });

  const records = readReviewerSidecars(dir);
  assert.deepEqual(
    records.map((record) => record.agentId),
    ['a2'],
  );
  for (const record of records) assert.ok(record.unit.length <= 64);
});

test('readReviewerSidecars tolerates a malformed meta without losing its neighbours', () => {
  const dir = plantSidecars({
    a1: { meta: '{"agentType":"general-purpose","descrip', lines: [] },
    a2: { meta: 'null' },
    a3: { meta: '[1,2,3]' },
    a4: {
      meta: meta({ description: 'forge-review final' }),
      lines: [assistantLine({ requestId: 'req_1', at: '2026-07-28T10:00:00.000Z' })],
    },
  });

  // The broken metas carry no readable description, so they name no unit and
  // yield no record — but they must not take a4 down with them.
  const records = readReviewerSidecars(dir);
  assert.deepEqual(
    records.map((record) => record.agentId),
    ['a4'],
  );
});

test('readReviewerSidecars returns records sorted by agentId, not in filesystem order', () => {
  // A contract guard, not a driver — the same caveat `readSubagents`' sort
  // test carries, for the same reason. `readdirSync` returns these names
  // already sorted on the filesystem this suite runs on, so this test cannot
  // fail here even with the sort removed; verified by removing it. It pins the
  // guarantee for filesystems that return hash or insertion order, where
  // persisted evidence would otherwise churn between runs.
  const ids = ['a90', 'a10', 'a50', 'a70', 'a30', 'a20'];
  const agents = {};
  for (const id of ids) agents[id] = { meta: meta({ description: 'forge-review final' }) };

  assert.deepEqual(
    readReviewerSidecars(plantSidecars(agents)).map((record) => record.agentId),
    ['a10', 'a20', 'a30', 'a50', 'a70', 'a90'],
  );
});

test('readReviewerSidecars returns [] for a directory it cannot read, instead of throwing', () => {
  const missing = path.join(tmp('forge-review-evidence-'), 'nope', 'subagents');
  const notADir = path.join(tmp('forge-review-evidence-'), 'file');
  fs.writeFileSync(notADir, 'not a directory');

  assert.deepEqual(readReviewerSidecars(missing), []);
  assert.deepEqual(readReviewerSidecars(notADir), []);
  assert.deepEqual(readReviewerSidecars(null), []);
  assert.deepEqual(readReviewerSidecars(undefined), []);
  assert.deepEqual(readReviewerSidecars(''), []);
  assert.deepEqual(readReviewerSidecars(42), []);
});

test('readReviewerSidecars lets no description text reach its output', () => {
  // Prescribing the description's *format* does not license storing its
  // *text*. These records are persisted into a digest that outlives the
  // session, and the description is free-form operator prose.
  const dir = plantSidecars({
    a1: {
      meta: meta({ description: 'forge-review final', stoppedByUser: true }),
      lines: [assistantLine({ requestId: 'req_1', at: '2026-07-28T10:00:00.000Z' })],
    },
    // A dispatch that is not a reviewer: its prose must not reach the output
    // either, now or if the matching rule is ever loosened again.
    a2: {
      meta: meta({ description: 'rotate the PRIVATE-SECRET credential' }),
      lines: [assistantLine({ requestId: 'req_2', at: '2026-07-28T10:00:00.000Z' })],
    },
  });

  const serialised = JSON.stringify(readReviewerSidecars(dir));
  assert.equal(serialised.includes('PRIVATE-SECRET'), false);
  assert.equal(serialised.includes('rotate'), false);
  assert.equal(serialised.includes('description'), false);
  // The description of a *matching* dispatch is equally not stored: the unit
  // crosses the boundary, the sentence it was cut from does not.
  assert.equal(serialised.includes('forge-review'), false);
  // The unit is the one string allowed across — and the fixture must actually
  // have produced a record, or the assertions above are vacuous.
  assert.equal(serialised.includes('final'), true);
});

// ---------------------------------------------------------------------------
// reviewEvidence
// ---------------------------------------------------------------------------

/** The Forge session every fixture below dispatches as. */
const DEMO_ID = '20260728T100000Z-demo-abc123';

const HOST_ID = 'f8447a2f-eb56-41b8-8cc1-16606b862780';

/** The second host conversation a resumed session binds to. */
const SECOND_HOST_ID = '11111111-2222-3333-4444-555555555555';

/**
 * Plant a `~/.claude`-shaped tree and return its config dir. Pass `configDir`
 * (the value this same function returned) to plant a second host session
 * beside the first, rather than into a fresh tree of its own — a session
 * bound to several host ids has them all under one project directory.
 */
function plantHost({
  sessionId = HOST_ID,
  lines = null,
  subagents = null,
  configDir = tmp('forge-review-evidence-host-'),
} = {}) {
  const project = path.join(configDir, 'projects', '-home-iztok-Projects-forgekit');
  fs.mkdirSync(project, { recursive: true });
  if (lines !== null) fs.writeFileSync(path.join(project, `${sessionId}.jsonl`), jsonl(lines));
  if (subagents !== null) plantSidecars(subagents, path.join(project, sessionId, 'subagents'));
  return configDir;
}

/** A session bound to one or more host ids, created at `createdAt`. */
function boundSession({ createdAt = '2026-07-28T10:00:00.000Z', sessionIds = [HOST_ID] } = {}) {
  return {
    id: '20260728T100000Z-demo-abc123',
    createdAt,
    host: { agent: 'claude-code', sessionIds, boundAt: createdAt },
  };
}

/** The parent transcript only has to exist for the binding to resolve. */
const PARENT = [assistantLine({ requestId: 'parent_1', at: '2026-07-28T10:00:00.000Z' })];

/** Copy the prototype-less units table so it can be compared to a literal. */
function plain(table) {
  return { ...table };
}

test('reviewEvidence cannot tell when the session was never bound to a host session', () => {
  const result = reviewEvidence({
    session: { id: 's1', createdAt: '2026-07-28T10:00:00.000Z', host: null },
    now: () => new Date('2026-07-28T12:00:00.000Z'),
    configDir: tmp('forge-review-evidence-host-'),
  });

  assert.equal(result.available, false);
  assert.match(result.reason, /host session/i);
  assert.deepEqual(plain(result.units), {});
});

test('reviewEvidence reports the units the host recorded a reviewer dispatch for', () => {
  const reviewerLines = [
    assistantLine({ requestId: 'rev_1', at: '2026-07-28T10:30:00.000Z' }),
    // Restated content block of the same reply — one request, two lines.
    assistantLine({ requestId: 'rev_1', at: '2026-07-28T10:30:01.000Z' }),
    assistantLine({ requestId: 'rev_2', at: '2026-07-28T10:31:00.000Z' }),
  ];
  const expectedRequests = new Set(reviewerLines.map((line) => line.requestId)).size;
  assert.notEqual(expectedRequests, reviewerLines.length);

  const configDir = plantHost({
    lines: PARENT,
    subagents: {
      a1: { meta: meta({ description: `forge-review final ${DEMO_ID}` }), lines: reviewerLines },
    },
  });

  const result = reviewEvidence({
    session: boundSession(),
    now: () => new Date('2026-07-28T12:00:00.000Z'),
    configDir,
  });

  assert.equal(result.available, true);
  assert.deepEqual(plain(result.units), {
    // One dispatch, unstopped, so the busiest is the whole total.
    final: { dispatched: 1, stopped: 0, requests: expectedRequests, maxRequests: expectedRequests },
  });
  // Available answers carry no excuse.
  assert.equal('reason' in result, false);
});

test('reviewEvidence tells "no reviewer ran" apart from "I could not tell"', () => {
  // The host recorded this session and its subagents; none of them was a
  // reviewer. That is a verdict the census may act on. It must not look like
  // the unavailable case, which must fall back to the prose rule instead.
  const configDir = plantHost({
    lines: PARENT,
    subagents: {
      a1: {
        meta: meta({ description: 'Implement Group 6: chip, composer, settings' }),
        lines: [assistantLine({ requestId: 'imp_1', at: '2026-07-28T10:30:00.000Z' })],
      },
    },
  });

  const looked = reviewEvidence({
    session: boundSession(),
    now: () => new Date('2026-07-28T12:00:00.000Z'),
    configDir,
  });
  const couldNotLook = reviewEvidence({
    session: { id: 's1', createdAt: '2026-07-28T10:00:00.000Z', host: null },
    now: () => new Date('2026-07-28T12:00:00.000Z'),
    configDir,
  });

  assert.equal(looked.available, true);
  assert.deepEqual(plain(looked.units), {});
  assert.equal('reason' in looked, false);

  assert.equal(couldNotLook.available, false);
  assert.equal(typeof couldNotLook.reason, 'string');
  assert.ok(couldNotLook.reason.length > 0);

  // The two answers agree on `units` and differ on everything that matters.
  assert.deepEqual(plain(looked.units), plain(couldNotLook.units));
  assert.notEqual(looked.available, couldNotLook.available);
});

test('reviewEvidence counts an operator-stopped dispatch against its unit', () => {
  const configDir = plantHost({
    lines: PARENT,
    subagents: {
      a1: {
        meta: meta({ description: `forge-review final ${DEMO_ID}`, stoppedByUser: true }),
        lines: [assistantLine({ requestId: 'rev_1', at: '2026-07-28T10:30:00.000Z' })],
      },
    },
  });

  const result = reviewEvidence({
    session: boundSession(),
    now: () => new Date('2026-07-28T12:00:00.000Z'),
    configDir,
  });

  assert.equal(result.available, true);
  assert.equal(result.units.final.dispatched, 1);
  assert.equal(result.units.final.stopped, 1);
});

test('reviewEvidence sums repeat dispatches for one unit', () => {
  const subagents = {};
  const perAgent = [1, 2, 3];
  const wasStopped = (index) => index === 0;
  for (const [index, requests] of perAgent.entries()) {
    subagents[`a${index}`] = {
      meta: meta({ description: `forge-review final ${DEMO_ID}`, stoppedByUser: wasStopped(index) ? true : undefined }),
      lines: Array.from({ length: requests }, (_, n) =>
        assistantLine({ requestId: `rev_${index}_${n}`, at: '2026-07-28T10:30:00.000Z' }),
      ),
    };
  }
  const expectedRequests = perAgent.reduce((sum, n) => sum + n, 0);
  const expectedMax = perAgent.reduce(
    (best, n, index) => (wasStopped(index) ? best : Math.max(best, n)),
    0,
  );

  const result = reviewEvidence({
    session: boundSession(),
    now: () => new Date('2026-07-28T12:00:00.000Z'),
    configDir: plantHost({ lines: PARENT, subagents }),
  });

  assert.deepEqual(plain(result.units), {
    final: {
      dispatched: perAgent.length,
      stopped: perAgent.filter((_, index) => wasStopped(index)).length,
      requests: expectedRequests,
      maxRequests: expectedMax,
    },
  });
});

// ---------------------------------------------------------------------------
// maxRequests — the busiest *single* unstopped dispatch
//
// The sum already there cannot be the measurement a floor reads: ten token
// dispatches for one unit add up to whatever the floor is. The maximum cannot
// be assembled out of small pieces, so it is the one that answers "did any one
// reviewer actually do work". Stopped dispatches are excluded because
// `hostFinalReview` grades a unit independent on `stopped < dispatched`: a long
// dispatch the operator killed, sitting beside a token dispatch that ran, would
// otherwise vouch for the token one.
// ---------------------------------------------------------------------------

/**
 * One `forge-review <unit> <this session>` sidecar per descriptor, each writing
 * `requests` distinct requests across two content blocks apiece — so a reader
 * counting lines rather than requests lands on a different number. A descriptor
 * with `requests: null` gets a meta and no transcript: the pruned `.jsonl`.
 */
function plantDispatches(descriptors, unit = 'final') {
  const subagents = {};
  for (const { agentId, requests, stopped } of descriptors) {
    subagents[agentId] = {
      meta: meta({
        description: `forge-review ${unit} ${DEMO_ID}`,
        stoppedByUser: stopped ? true : undefined,
      }),
      lines:
        requests === null
          ? undefined
          : Array.from({ length: requests * 2 }, (_, n) =>
              assistantLine({
                requestId: `${agentId}_req_${Math.floor(n / 2)}`,
                at: '2026-07-28T10:30:00.000Z',
              }),
            ),
    };
  }
  return plantHost({ lines: PARENT, subagents });
}

/** What the bucket should say, derived from the fixture and nothing else. */
function expectedBucket(descriptors) {
  return {
    dispatched: descriptors.length,
    stopped: descriptors.filter((d) => d.stopped).length,
    requests: descriptors.reduce((sum, d) => sum + (d.requests ?? 0), 0),
    maxRequests: descriptors
      .filter((d) => !d.stopped)
      .reduce((best, d) => Math.max(best, d.requests ?? 0), 0),
  };
}

test('reviewEvidence reports the busiest unstopped dispatch beside the total', () => {
  // The stopped one is the *busier*, so a maximum that ignored `stoppedByUser`
  // would report its count instead — the exact confusion that lets a killed
  // reviewer vouch for a token one that ran beside it. And there are two
  // unstopped dispatches of different sizes, so a reader that added them up
  // instead of taking the largest is caught too: that sum is the evasion the
  // maximum exists to defeat, so a fixture with one unstopped dispatch cannot
  // tell the two rules apart.
  const dispatches = [
    { agentId: 'a1', requests: 4, stopped: true },
    { agentId: 'a2', requests: 3, stopped: false },
    { agentId: 'a3', requests: 2, stopped: false },
  ];
  const expected = expectedBucket(dispatches);
  // Every wrong answer a plausible implementation could give must differ from
  // the right one, or this asserts only that some rule ran.
  assert.notEqual(expected.maxRequests, expected.requests, 'max over all vs sum over all');
  assert.notEqual(
    expected.maxRequests,
    Math.max(...dispatches.map((d) => d.requests)),
    'the stopped dispatch must be the busier one, or the exclusion is untested',
  );
  assert.notEqual(
    expected.maxRequests,
    dispatches.filter((d) => !d.stopped).reduce((sum, d) => sum + d.requests, 0),
    'the unstopped dispatches must differ in size, or a sum reads as a max',
  );

  const result = reviewEvidence({
    session: boundSession(),
    configDir: plantDispatches(dispatches),
  });

  assert.equal(result.available, true);
  assert.deepEqual(plain(result.units), { final: expected });
});

test('reviewEvidence reports a busiest of zero when every dispatch was stopped', () => {
  const dispatches = [
    { agentId: 'a1', requests: 3, stopped: true },
    { agentId: 'a2', requests: 5, stopped: true },
  ];
  const expected = expectedBucket(dispatches);
  assert.equal(expected.maxRequests, 0);
  // The total is untouched by the exclusion: this unit did burn requests, and
  // `requests` still says so. Only the busiest *unstopped* one is zero.
  assert.ok(expected.requests > 0);

  const result = reviewEvidence({
    session: boundSession(),
    configDir: plantDispatches(dispatches),
  });

  assert.deepEqual(plain(result.units), { final: expected });
});

test('reviewEvidence reports the whole total as the busiest for a lone unstopped dispatch', () => {
  const dispatches = [{ agentId: 'a1', requests: 4, stopped: false }];
  const expected = expectedBucket(dispatches);
  assert.equal(expected.maxRequests, expected.requests);
  // More than one request, or "the max equals the sum" holds for any reader.
  assert.ok(expected.requests > 1);

  const result = reviewEvidence({
    session: boundSession(),
    configDir: plantDispatches(dispatches),
  });

  assert.deepEqual(plain(result.units), { final: expected });
});

test('reviewEvidence keeps a pruned-transcript dispatch in the unit, contributing zero', () => {
  // A meta with no `.jsonl` beside it counts zero requests. It must still be a
  // dispatch — dropping it would report one fewer reviewer than demonstrably
  // ran, the collapse of absence into a negative this module exists to stop —
  // and it must not become the busiest.
  const dispatches = [
    { agentId: 'a1', requests: null, stopped: false },
    { agentId: 'a2', requests: 2, stopped: false },
  ];
  const expected = expectedBucket(dispatches);
  assert.equal(expected.dispatched, 2, 'the pruned record is one of the two');

  const result = reviewEvidence({
    session: boundSession(),
    configDir: plantDispatches(dispatches),
  });

  assert.deepEqual(plain(result.units), { final: expected });
});

test('reviewEvidence reports a busiest of zero for a unit whose only dispatch was pruned', () => {
  const dispatches = [{ agentId: 'a1', requests: null, stopped: false }];
  const expected = expectedBucket(dispatches);
  assert.equal(expected.maxRequests, 0);

  const result = reviewEvidence({
    session: boundSession(),
    configDir: plantDispatches(dispatches),
  });

  // Present with zero counts, not absent: `dispatched: 1` is what separates
  // "a reviewer ran and left no transcript" from "no reviewer ran".
  assert.deepEqual(plain(result.units), { final: expected });
});

test('reviewEvidence gives the pruned-transcript and absent-sidecar cases distinct reasons', () => {
  // Both are unavailable, but a caller reading the reason must be able to tell
  // a pruned host transcript from a session that wrote no sidecars: matching
  // both with one loose pattern let the whole `bound.length === 0` branch be
  // deleted without a test noticing.
  const pruned = reviewEvidence({
    session: boundSession(),
    now: () => new Date('2026-07-28T12:00:00.000Z'),
    configDir: plantHost({ lines: null }),
  });
  const noSidecar = reviewEvidence({
    session: boundSession(),
    now: () => new Date('2026-07-28T12:00:00.000Z'),
    configDir: plantHost({ lines: PARENT, subagents: null }),
  });

  assert.equal(pruned.available, false);
  assert.match(pruned.reason, /no transcript on disk/i);
  assert.equal(/no transcript on disk/i.test(noSidecar.reason), false);

  assert.equal(noSidecar.available, false);
  assert.match(noSidecar.reason, /no sidecar directory/i);
  assert.equal(/no sidecar directory/i.test(pruned.reason), false);

  assert.notEqual(pruned.reason, noSidecar.reason);

  // Every bound transcript pruned is not a partial measurement — it is no
  // measurement at all, and `partial` is a placeholder here in exactly the
  // sense `seen` and `prescribed` are. `available` is what discriminates; a
  // caller reading `partial: false` off an unavailable answer as "complete"
  // has already made the mistake this module's whole shape warns about.
  assert.equal(pruned.partial, false);
  assert.equal(noSidecar.partial, false);
});

test('reviewEvidence cannot tell when the sidecar directory exists but cannot be read', () => {
  // The defect this replaces: `readdirSync` failing was swallowed into `[]`,
  // which is indistinguishable from an empty directory, so a reviewer that
  // genuinely ran was reported as one that never was — and group 2 would then
  // refuse the change at the gate.
  const configDir = plantHost({
    lines: PARENT,
    subagents: {
      a1: {
        meta: meta({ description: `forge-review final ${DEMO_ID}` }),
        lines: [assistantLine({ requestId: 'rev_1', at: '2026-07-28T10:30:00.000Z' })],
      },
    },
  });
  const dir = path.join(configDir, 'projects', '-home-iztok-Projects-forgekit', HOST_ID, 'subagents');
  fs.chmodSync(dir, 0o000);
  try {
    // The fixture is only meaningful if the process genuinely cannot read it.
    assert.throws(() => fs.readdirSync(dir), /EACCES/);

    const result = reviewEvidence({
      session: boundSession(),
      now: () => new Date('2026-07-28T12:00:00.000Z'),
      configDir,
    });

    assert.equal(result.available, false);
    assert.match(result.reason, /could not be read/i);
  } finally {
    fs.chmodSync(dir, 0o755);
  }
});

test('reviewEvidence answers from the surviving half when a bound session has no transcript at all', () => {
  // A DELIBERATE LIMIT, PINNED IN THE PERMISSIVE DIRECTION — not a behaviour
  // this change adds. Spec scenario "A transcript that was pruned, not
  // blocked": a session bound to two host sessions where the *older*
  // transcript is simply absent from disk (pruned, not blocked — no `chmod`
  // anywhere in this fixture) still answers confidently from the surviving
  // newer one, and a reviewer that ran in the pruned half stays invisible.
  //
  // That is intentional. The over-cautious alternative — refusing whenever
  // `bound.length < sessionIds.length` — is exactly what an audit inserted
  // into `reviewEvidence` and watched the entire suite stay green, because
  // nothing pinned this limit before this test. Rejected because it would make
  // *every* resumed session unavailable the moment its older transcript ages
  // out of the host's retention window, which is a matter of days. The real
  // fix is a dispatch-time stamp written into the review artefact itself —
  // read from the artefact this module verifies, not reconstructed from a
  // transcript that may no longer be on disk. That stamp is built and shipped
  // (F12, `review-stamp.mjs`), and the rule the census applies to it is stated
  // in full beside the `partial` flag in `review-evidence.mjs`: it decides
  // wherever the host cannot answer — which includes this module answering
  // unavailable but is not limited to it — and it additionally overrides an
  // absence-negative measured from a partial binding, which is what covers
  // *this* case. A measured stop and a complete binding's absence always win.
  // `partial` is reported on the available answer below and pinned by the tests
  // under the `partial` heading: the answer stays available and now says it was
  // measured from half the binding.
  const ABSENT_ID = '00000000-1111-2222-3333-444444444444';

  const configDir = plantHost({
    sessionId: HOST_ID,
    lines: PARENT,
    subagents: {
      a1: {
        meta: meta({ description: `forge-review final ${DEMO_ID}` }),
        lines: [assistantLine({ requestId: 'f_1', at: '2026-07-28T11:00:00.000Z' })],
      },
    },
  });
  // ABSENT_ID has no `.jsonl` anywhere under `projects/` — not chmod'd,
  // genuinely never written. `findTranscripts` omits it from both `found` and
  // `unreadable`: the ordinary ENOENT case, not a blocked read.

  const result = reviewEvidence({
    session: boundSession({ sessionIds: [ABSENT_ID, HOST_ID] }),
    now: () => new Date('2026-07-28T12:00:00.000Z'),
    configDir,
  });

  // Both assertions matter: `available` alone would still pass if the
  // surviving half stopped being read properly. Measured — a mutation that
  // returns `available: true` with empty `units` is caught by the second and
  // not the first. `?.` so that mutation reddens with a readable diff rather
  // than a TypeError from reading `dispatched` of undefined.
  assert.equal(result.available, true);
  assert.equal(result.units.final?.dispatched, 1);
  // The limit is unchanged and now audible: the same permissive answer, with
  // the fact that half the binding went unmeasured attached to it. This is the
  // shape the retention window produces in production — an id that was never
  // written to this tree at all, not one deleted from it.
  assert.equal(result.partial, true);
});

// ---------------------------------------------------------------------------
// partial — was this answer measured from the whole binding, or half of it?
//
// The residual the test above pins deliberately in the permissive direction:
// a session bound to two host conversations whose older transcript has been
// pruned still answers `available: true`, from half the record. The answer is
// right to stay available; what was missing is that it never said it was half.
// A negative measured that way — no `final` unit in `units` — reads at the
// census exactly like a complete measurement of a session nobody reviewed, and
// the money/auth gate refuses on it. `partial` is the fact that distinguishes
// them, and `review-census.mjs` reads it: a valid dispatch stamp now overrides
// that absence-negative when the flag says the binding was partial, so the
// stamped reviewer who ran in the pruned half is no longer erased. Only that
// one negative — a measured stop and a complete binding's absence both still
// stand against any stamp.
// ---------------------------------------------------------------------------

/**
 * The two-bound-session tree: both host sessions on disk, each with a sidecar
 * holding one dispatch — a *group* review in the first, the `final` reviewer in
 * the second, so the two halves are distinguishable in `units` and a reader
 * that opens only one of them is caught.
 */
function plantTwoBound() {
  const configDir = plantHost({
    sessionId: HOST_ID,
    lines: PARENT,
    subagents: {
      a1: {
        meta: meta({ description: `forge-review group-01 ${DEMO_ID}` }),
        lines: [assistantLine({ requestId: 'g_1', at: '2026-07-28T10:30:00.000Z' })],
      },
    },
  });
  plantHost({
    configDir,
    sessionId: SECOND_HOST_ID,
    lines: PARENT,
    subagents: {
      a2: {
        meta: meta({ description: `forge-review final ${DEMO_ID}` }),
        lines: [assistantLine({ requestId: 'f_1', at: '2026-07-28T11:00:00.000Z' })],
      },
    },
  });
  return configDir;
}

test('reviewEvidence reports a two-session binding it could read in full as not partial', () => {
  const configDir = plantTwoBound();

  const result = reviewEvidence({
    session: boundSession({ sessionIds: [HOST_ID, SECOND_HOST_ID] }),
    configDir,
  });

  assert.equal(result.available, true);
  // Strictly `false`, never `undefined`: a field that does not exist is not a
  // report that the binding was complete.
  assert.equal(result.partial, false);
  // Both halves were genuinely read, or "not partial" would be true for a
  // reader that never opened the second one.
  assert.deepEqual(Object.getOwnPropertyNames(result.units).sort(), ['final', 'group-01']);
});

test('reviewEvidence reports a single bound session on disk as not partial', () => {
  const configDir = plantHost({
    lines: PARENT,
    subagents: {
      a1: {
        meta: meta({ description: `forge-review final ${DEMO_ID}` }),
        lines: [assistantLine({ requestId: 'rev_1', at: '2026-07-28T10:30:00.000Z' })],
      },
    },
  });

  const result = reviewEvidence({ session: boundSession(), configDir });

  assert.equal(result.available, true);
  assert.equal(result.partial, false);
});

test('reviewEvidence reports an answer measured over a pruned bound session as partial', () => {
  // The F58 residual, now audible. The older host session's transcript is
  // genuinely gone — deleted, not chmod'd, the ordinary ENOENT case
  // `findTranscripts` omits from both its lists — and the answer still comes
  // back available, from the surviving half alone. That much is the deliberate
  // limit pinned above. What is new is that the answer now says so.
  const configDir = plantTwoBound();
  const project = path.join(configDir, 'projects', '-home-iztok-Projects-forgekit');
  fs.rmSync(path.join(project, `${HOST_ID}.jsonl`));
  fs.rmSync(path.join(project, HOST_ID), { recursive: true });
  // The fixture only means anything if the older half is really unresolvable
  // and the newer one really is not.
  assert.equal(fs.existsSync(path.join(project, `${HOST_ID}.jsonl`)), false);
  assert.equal(fs.existsSync(path.join(project, `${SECOND_HOST_ID}.jsonl`)), true);

  const result = reviewEvidence({
    session: boundSession({ sessionIds: [HOST_ID, SECOND_HOST_ID] }),
    configDir,
  });
  // What the surviving half alone says, measured rather than retyped: binding
  // only the id whose transcript is still there, against the same tree.
  const survivor = reviewEvidence({
    session: boundSession({ sessionIds: [SECOND_HOST_ID] }),
    configDir,
  });

  assert.equal(result.available, true);
  assert.equal(result.partial, true);

  // Everything else is the surviving half's answer, unchanged: `partial` adds
  // a fact, it does not alter the measurement. The survivor must actually have
  // measured something, or this pair agrees on emptiness and proves nothing.
  assert.deepEqual(plain(result.units), plain(survivor.units));
  assert.equal(result.seen, survivor.seen);
  assert.equal(result.prescribed, survivor.prescribed);
  assert.equal(survivor.units.final?.dispatched, 1);
  // ...and the survivor, bound to nothing else, is a complete measurement. The
  // same tree answers both ways depending only on what was bound, so `partial`
  // cannot be a constant.
  assert.equal(survivor.partial, false);
  // The pruned half's own dispatch is absent, which is exactly why `partial`
  // has to be reported: this negative is not a complete measurement.
  assert.equal('group-01' in plain(result.units), false);
});

test('a bound host id repeated in the binding is not a partial binding', () => {
  // WHAT WAS FOUND, since the answer decides the shape of this test: neither
  // `reviewEvidence` nor `findTranscripts` dedupes `host.sessionIds`.
  // `findTranscripts` resolves a repeated id once per occurrence, so `found`
  // grows in step with the ids and a length comparison happens to survive —
  // but only by coincidence, and `reviewEvidence` scans the repeated sidecar
  // directory twice, which double-counts the units (pre-existing, out of this
  // task's scope, and unreachable through `bindHost`, which appends an id only
  // when it is not already present).
  //
  // So the guard here is narrow and exact: a repeat must never read as an id
  // that resolved to nothing. It is the id, not the count, that decides.
  const configDir = plantHost({
    lines: PARENT,
    subagents: {
      a1: {
        meta: meta({ description: `forge-review final ${DEMO_ID}` }),
        lines: [assistantLine({ requestId: 'rev_1', at: '2026-07-28T10:30:00.000Z' })],
      },
    },
  });

  const result = reviewEvidence({
    session: boundSession({ sessionIds: [HOST_ID, HOST_ID] }),
    configDir,
  });

  assert.equal(result.available, true);
  assert.equal(result.partial, false, 'the same id twice is one resolved id, not one missing');
  // The dispatch was found, so this is not passing over an empty answer.
  assert.ok(result.units.final?.dispatched >= 1);
});

test('reviewEvidence cannot tell when the sidecar path exists and is not a directory', () => {
  // The same not-a-directory arm host.test.mjs pins at `findTranscripts` level
  // ("findTranscripts reports a sidecar path that exists but is not a
  // directory as unreadable") — run here through `reviewEvidence`, the layer
  // the spec's scenario actually names ("WHEN the census runs"). Safe today
  // only because `reviewEvidence` treats every `unreadable` entry identically
  // regardless of why it is unreadable — a property worth pinning rather than
  // assuming, since the two arms of this scenario (blocked vs. not-a-directory)
  // are produced by different branches in `host.mjs`.
  const configDir = plantHost({ lines: PARENT, subagents: null });
  const hostDir = path.join(configDir, 'projects', '-home-iztok-Projects-forgekit', HOST_ID);
  fs.mkdirSync(hostDir, { recursive: true });
  fs.writeFileSync(path.join(hostDir, 'subagents'), 'not a directory');

  const result = reviewEvidence({
    session: boundSession(),
    now: () => new Date('2026-07-28T12:00:00.000Z'),
    configDir,
  });

  assert.equal(result.available, false);
  assert.match(result.reason, /not a directory/i);
});

test('reviewEvidence stays unavailable when only one of two bound host sessions can be searched', () => {
  // THE HOLE THIS PINS, in the past tense it belongs in: `findTranscripts`'s
  // sidecar `catch` used to be empty, so a sidecar dir that could not be
  // *statted* came back as `sidecarDir: null` — byte-identical to a session
  // that dispatched nothing — and the guard below it (`sidecarDirs.length ===
  // 0`) only gave up when *every* bound id was unresolvable. With two bound
  // ids where the first resolved, that first session alone answered
  // `available: true`, and a reviewer that ran in the second was simply
  // absent from `units`.
  //
  // `chmod 000` on the `subagents/` directory itself does not reproduce this:
  // `statSync` on a `000` directory succeeds, because stat reads the entry in
  // the parent (that is the fixture the test above this one uses, and it pins
  // `readdirSync` throwing inside the scan — a different, already-fixed hole).
  // What reproduces *this* hole is `chmod 000` on the host session directory
  // one level up: the sibling transcript file still stats fine, so the id
  // binds, but `statSync` on `subagents/` inside the now-unsearchable
  // directory throws `EACCES` — which `findTranscripts` now reports in
  // `unreadable` rather than discarding, and this test pins that it stays
  // that way.
  // The two-bound tree `plantTwoBound` builds, whose shape is the argument:
  // the first host session is fully readable and its one dispatch is a *group*
  // review — not `final` — so it alone can supply `prescribed > 0` but cannot
  // supply the final reviewer, while the final reviewer ran in the second,
  // whose session directory is about to be made unsearchable. A buggy reader
  // that stops at the first resolvable session reports `available: true` with
  // `final` absent from `units`, which is exactly the false "no independent
  // reviewer" the gate must not act on.
  const configDir = plantTwoBound();

  const project = path.join(configDir, 'projects', '-home-iztok-Projects-forgekit');
  const secondHostDir = path.join(project, SECOND_HOST_ID);
  const secondSidecarPath = path.join(secondHostDir, 'subagents');
  fs.chmodSync(secondHostDir, 0o000);
  try {
    // Prove the fixture is genuinely unreadable, and that the sibling
    // transcript is not — or the assertion below would be passing for free.
    assert.throws(() => fs.statSync(secondSidecarPath), /EACCES/);
    assert.equal(fs.statSync(path.join(project, `${SECOND_HOST_ID}.jsonl`)).isFile(), true);

    const result = reviewEvidence({
      session: boundSession({ sessionIds: [HOST_ID, SECOND_HOST_ID] }),
      now: () => new Date('2026-07-28T12:00:00.000Z'),
      configDir,
    });

    // A binding that could only be read in part must not decide the gate: the
    // reviewer dispatched in the unsearchable half must not be reported absent.
    assert.equal(result.available, false);
    // THE REASON NAMES THE HOST SESSION ID AND THE PATH — the spec's own
    // closing line for this scenario, and the only diagnostic an operator gets
    // when the gate stands aside. Unpinned before this: an audit replaced the
    // whole detail string with a literal and the suite stayed green, because
    // only `available === false` was ever asserted here. `SECOND_HOST_ID` is
    // the fixture's own constant, not retyped from anywhere else.
    assert.match(result.reason, new RegExp(SECOND_HOST_ID));
    assert.match(result.reason, /subagents/);
    // A blocked binding is refused, never reported as a partial measurement:
    // the F27 guard fires before anything is counted, so `partial` is the same
    // placeholder every unavailable answer carries.
    assert.equal(result.partial, false);
  } finally {
    fs.chmodSync(secondHostDir, 0o755);
  }
});

test('reviewEvidence names the blocked id and path, not "pruned", when every bound session is blocked', () => {
  // F57. `findTranscripts`'s own `unreadable` split (prior change) already
  // tells "located but sidecar-blocked" apart from "never found at all" — but
  // `reviewEvidence` checks `bound.length === 0` *before* `unreadable.length >
  // 0`, so a binding where the sole host session is blocked at the *locating*
  // layer (not sidecar, the transcript stat itself) still falls through to the
  // `bound.length === 0` branch and answers with the pruned-or-elsewhere
  // message — an operator reading it as "cleaned up by the host" instead of
  // "we could not look at it".
  //
  // The fixture: a project directory holding exactly one bound id's
  // transcript, `chmod 000`. `statSync` on a path *inside* a `000` directory
  // throws EACCES (unlike `chmod 000` on the host-session directory used
  // above, which only blocks the *sidecar* one level down and leaves the
  // sibling transcript file readable). With no other project directory to
  // find it in, the id is promoted to `unreadable` and never reaches `found` —
  // this is the locating-layer block, distinct from the reading-layer block
  // task (c) in `collect.test.mjs` pins.
  const configDir = plantHost({ sessionId: HOST_ID, lines: PARENT, subagents: null });
  const project = path.join(configDir, 'projects', '-home-iztok-Projects-forgekit');
  const transcript = path.join(project, `${HOST_ID}.jsonl`);
  fs.chmodSync(project, 0o000);
  try {
    // The fixture is only meaningful if the process genuinely cannot see
    // inside the directory, and genuinely could locate the file before it was
    // blocked — or the assertions below would be passing for free.
    assert.throws(() => fs.statSync(transcript), /EACCES/);

    const result = reviewEvidence({
      session: boundSession(),
      now: () => new Date('2026-07-28T12:00:00.000Z'),
      configDir,
    });

    // The decision was already correct before this change — pinned here as
    // sanity, not as the defect.
    assert.equal(result.available, false);
    // THE DIAGNOSIS, not the decision. Today's reason is the literal pruned
    // message, `no transcript on disk for host session ${HOST_ID} — pruned or
    // written elsewhere`: `sessionIds.join(', ')` happens to equal `HOST_ID`
    // for a single-session binding, so this id assertion alone already
    // passes today — id-match is a spec requirement to keep true after the
    // fix, not by itself proof of the bug. `HOST_ID` is the fixture's own
    // constant.
    assert.match(result.reason, new RegExp(HOST_ID));
    // The path does NOT appear in today's message — this is where it dies.
    // Built from the same `configDir`/`HOST_ID` the fixture used, not typed,
    // and escaped since a tmp path can contain regex metacharacters.
    assert.match(result.reason, new RegExp(transcript.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    // Today's reason IS "pruned or written elsewhere" verbatim — this also
    // dies, on the same wrong-diagnosis message the path assertion just
    // caught missing its path.
    assert.doesNotMatch(result.reason, /pruned or written elsewhere/);
  } finally {
    fs.chmodSync(project, 0o755);
  }
});

test('reviewEvidence cannot tell when a dispatch record in the window cannot be read', () => {
  // One level finer than the directory case: the meta is there and unreadable,
  // so we know a subagent ran and cannot know whether it was the reviewer.
  // `readMeta` returning `{}` for unreadable and for absent alike is what made
  // this read as "no reviewer was dispatched".
  const configDir = plantHost({
    lines: PARENT,
    subagents: {
      a1: {
        meta: meta({ description: `forge-review final ${DEMO_ID}` }),
        lines: [assistantLine({ requestId: 'rev_1', at: '2026-07-28T10:30:00.000Z' })],
      },
    },
  });
  const metaFile = path.join(
    configDir,
    'projects',
    '-home-iztok-Projects-forgekit',
    HOST_ID,
    'subagents',
    'agent-a1.meta.json',
  );
  fs.chmodSync(metaFile, 0o000);
  try {
    assert.throws(() => fs.readFileSync(metaFile, 'utf8'), /EACCES/);

    const result = reviewEvidence({
      session: boundSession(),
      now: () => new Date('2026-07-28T12:00:00.000Z'),
      configDir,
    });

    assert.equal(result.available, false);
    assert.match(result.reason, /could not be read/i);
  } finally {
    fs.chmodSync(metaFile, 0o644);
  }
});

test('reviewEvidence cannot tell when a dispatch record in the window is malformed', () => {
  // Same hole, reachable without a permission bit: a corrupt meta beside a
  // real transcript is a subagent whose nature is unknowable.
  const configDir = plantHost({
    lines: PARENT,
    subagents: {
      a1: {
        meta: '{"agentType":"general-purpose","descrip',
        lines: [assistantLine({ requestId: 'rev_1', at: '2026-07-28T10:30:00.000Z' })],
      },
    },
  });

  const result = reviewEvidence({
    session: boundSession(),
    now: () => new Date('2026-07-28T12:00:00.000Z'),
    configDir,
  });

  assert.equal(result.available, false);
  assert.match(result.reason, /could not be read/i);
});

test('reviewEvidence cannot tell when a transcript in the window has no dispatch record', () => {
  // The mirror case: a subagent transcript whose meta is gone. We know a
  // subagent ran in this window and cannot know what it was.
  const configDir = plantHost({
    lines: PARENT,
    subagents: {
      a1: { lines: [assistantLine({ requestId: 'rev_1', at: '2026-07-28T10:30:00.000Z' })] },
    },
  });

  const result = reviewEvidence({
    session: boundSession(),
    now: () => new Date('2026-07-28T12:00:00.000Z'),
    configDir,
  });

  assert.equal(result.available, false);
  assert.match(result.reason, /could not be read/i);
});

test('reviewEvidence keys units by a bare table, so a unit named constructor is counted', () => {
  // `constructor` is the inherited name a real unit can actually collide with:
  // it is all-lowercase, so it survives the unit's normalisation, where
  // `__proto__` and `toString` do not (a leading `_` is not a legal unit
  // character and `toString` lower-cases to a harmless `tostring`). On an
  // ordinary object `units[unit] ??= {...}` would find the inherited
  // constructor, skip the assignment and add the counts to a shared function —
  // the unit would vanish from the table entirely.
  const configDir = plantHost({
    lines: PARENT,
    subagents: {
      a1: {
        meta: meta({ description: `forge-review constructor ${DEMO_ID}` }),
        lines: [assistantLine({ requestId: 'rev_1', at: '2026-07-28T10:30:00.000Z' })],
      },
    },
  });

  const result = reviewEvidence({
    session: boundSession(),
    now: () => new Date('2026-07-28T12:00:00.000Z'),
    configDir,
  });

  assert.deepEqual(Object.getOwnPropertyNames(result.units), ['constructor']);
  assert.deepEqual(result.units.constructor, {
    dispatched: 1,
    stopped: 0,
    requests: 1,
    maxRequests: 1,
  });
  // The counts land on whatever `units.constructor` resolves to. On an
  // ordinary object that is the `Object` constructor *function* — not
  // `Object.prototype`, as an earlier comment here wrongly claimed — so this
  // is the assertion that can actually fail, and `{}.dispatched` is not.
  assert.equal(Object.dispatched, undefined);
});

test('reviewEvidence lets no description text reach its output', () => {
  const configDir = plantHost({
    lines: PARENT,
    subagents: {
      a1: {
        meta: meta({ description: `forge-review final ${DEMO_ID}` }),
        lines: [assistantLine({ requestId: 'rev_1', at: '2026-07-28T10:30:00.000Z' })],
      },
      a2: {
        meta: meta({ description: 'rotate the PRIVATE-SECRET credential' }),
        lines: [assistantLine({ requestId: 'imp_1', at: '2026-07-28T10:30:00.000Z' })],
      },
    },
  });

  const result = reviewEvidence({
    session: boundSession(),
    now: () => new Date('2026-07-28T12:00:00.000Z'),
    configDir,
  });

  const serialised = JSON.stringify(result);
  assert.equal(serialised.includes('PRIVATE-SECRET'), false);
  assert.equal(serialised.includes('rotate'), false);
  assert.equal(serialised.includes('description'), false);
  assert.equal(serialised.includes('forge-review'), false);
  assert.equal(serialised.includes('final'), true);
});

test('reviewEvidence degrades instead of throwing on junk input', () => {
  for (const options of [undefined, null, 'nope', 42, {}, { session: 'nope' }]) {
    const result = reviewEvidence(options);
    assert.equal(result.available, false);
    assert.equal(typeof result.reason, 'string');
    assert.deepEqual(plain(result.units), {});
  }
});

test('reviewEvidence degrades instead of throwing when reading the session itself throws', () => {
  // The catch-all is the contract, not a formality: this runs inside
  // `forge phase done` and an exception here would block a transition.
  const session = {
    createdAt: '2026-07-28T10:00:00.000Z',
    get host() {
      throw new Error('session object is booby-trapped');
    },
  };

  const result = reviewEvidence({
    session,
    now: () => new Date('2026-07-28T12:00:00.000Z'),
    configDir: tmp('forge-review-evidence-host-'),
  });

  assert.equal(result.available, false);
  assert.match(result.reason, /booby-trapped/);
  assert.deepEqual(plain(result.units), {});
});

test('reviewEvidence cannot tell when a dispatch has no readable description', () => {
  // The third and last site of the collapse. `unitOf` returns null both for
  // "this description says it is not a review dispatch" and for "there is no
  // description to read", and the second is a subagent visibly there but
  // unidentifiable — a problem, not a negative.
  //
  // Unreachable on today's corpus: `description` is a non-empty string on
  // every real meta. But it is an undocumented host field, and `host.mjs`
  // states that host field shapes are not a contract. A release that renames
  // or nests it would make every dispatch unidentifiable at once, and without
  // this the gate would refuse every change with no reason to diagnose it.
  const shapes = [
    ['absent', { agentType: 'general-purpose', spawnDepth: 1 }],
    ['null', { description: null }],
    ['a number', { description: 42 }],
    ['empty', { description: '' }],
    ['whitespace', { description: '   ' }],
    ['an object', { description: {} }],
    ['an array', { description: [] }],
  ];

  for (const [label, agentMeta] of shapes) {
    const configDir = plantHost({
      lines: PARENT,
      subagents: {
        a1: {
          meta: agentMeta,
          lines: [assistantLine({ requestId: 'rev_1', at: '2026-07-28T10:30:00.000Z' })],
        },
      },
    });

    const result = reviewEvidence({
      session: boundSession(),
      now: () => new Date('2026-07-28T12:00:00.000Z'),
      configDir,
    });

    assert.equal(result.available, false, `description ${label} should not be an answer`);
    assert.match(result.reason, /description/i);
    // Deliberately not asserting seen/prescribed here: on an unavailable answer
    // they are placeholders, so `0` pins `unavailable()`'s literal rather than
    // any tallying behaviour. A reviewer proved that by adding `seen += 99`
    // before the return and watching the whole suite stay green. The tally is
    // tested on available answers, where it means something.
  }
});

test('reviewEvidence cannot tell when a meta parses to something that is not an object', () => {
  // `null` and `[1,2,3]` parse cleanly and are not metadata. They reach
  // `reviewEvidence` only through the scan's problem channel, which the
  // `readReviewerSidecars` test for the same fixtures cannot see.
  for (const raw of ['null', '[1,2,3]', '"a string"', '7']) {
    const configDir = plantHost({
      lines: PARENT,
      subagents: {
        a1: {
          meta: raw,
          lines: [assistantLine({ requestId: 'rev_1', at: '2026-07-28T10:30:00.000Z' })],
        },
      },
    });

    const result = reviewEvidence({
      session: boundSession(),
      now: () => new Date('2026-07-28T12:00:00.000Z'),
      configDir,
    });

    assert.equal(result.available, false, `meta ${raw} should not be an answer`);
    assert.match(result.reason, /could not be read/i);
  }
});

test('reviewEvidence tells "the convention is not in use" from "no reviewer ran"', () => {
  // The distinction task 2.1b consumes. Both are `available: true` with no
  // units, and conflating them is what would have made the gate refuse
  // essentially every session: on the real corpus plenty of dispatches are
  // review-shaped and almost none carries the prescribed label, so
  // `prescribed === 0` is overwhelmingly "nobody has adopted the convention",
  // not "nobody reviewed".
  const conventionUnused = reviewEvidence({
    session: boundSession(),
    now: () => new Date('2026-07-28T12:00:00.000Z'),
    configDir: plantHost({
      lines: PARENT,
      subagents: {
        a1: {
          meta: meta({ description: 'Group 1 review: host binding' }),
          lines: [assistantLine({ requestId: 'rev_1', at: '2026-07-28T10:30:00.000Z' })],
        },
        a2: {
          meta: meta({ description: 'Independent review of the cap stack' }),
          lines: [assistantLine({ requestId: 'rev_2', at: '2026-07-28T10:31:00.000Z' })],
        },
      },
    }),
  });

  const nothingRan = reviewEvidence({
    session: boundSession(),
    now: () => new Date('2026-07-28T12:00:00.000Z'),
    configDir: plantHost({ lines: PARENT, subagents: {} }),
  });

  // Identical on every field the round-1 contract had...
  assert.equal(conventionUnused.available, true);
  assert.equal(nothingRan.available, true);
  assert.deepEqual(plain(conventionUnused.units), plain(nothingRan.units));

  // ...and distinguishable only by the new pair.
  assert.equal(conventionUnused.seen, 2);
  assert.equal(conventionUnused.prescribed, 0);
  assert.equal(nothingRan.seen, 0);
  assert.equal(nothingRan.prescribed, 0);
  assert.notEqual(conventionUnused.seen, nothingRan.seen);
});

test('reviewEvidence counts prescribed dispatches in both tallies', () => {
  const configDir = plantHost({
    lines: PARENT,
    subagents: {
      a1: {
        meta: meta({ description: `forge-review final ${DEMO_ID}` }),
        lines: [assistantLine({ requestId: 'rev_1', at: '2026-07-28T10:30:00.000Z' })],
      },
      a2: {
        meta: meta({ description: 'Implement Group 6: chip, composer, settings' }),
        lines: [assistantLine({ requestId: 'imp_1', at: '2026-07-28T10:31:00.000Z' })],
      },
    },
  });

  const result = reviewEvidence({
    session: boundSession(),
    now: () => new Date('2026-07-28T12:00:00.000Z'),
    configDir,
  });

  // A prescribed dispatch is a dispatch: it counts in `seen` too, or `seen`
  // would not be "every identifiable dispatch".
  assert.equal(result.seen, 2);
  assert.equal(result.prescribed, 1);
  assert.equal(result.units.final.dispatched, result.prescribed);
});

test('an unplaceable unlabelled dispatch still counts as seen', () => {
  // Reversed after the final review (I3). This case originally asserted
  // `seen: 0`, reasoning that an unplaceable dispatch must not inflate `seen`
  // and send to prose a session that could have been judged on evidence. That
  // weighs the wrong two outcomes against each other: the cost of counting it
  // is losing a *grade*, and the cost of dropping it is `seen === 0`, which
  // task 2.1b reads as "nothing ran at all" and which **refuses the work** at
  // the money/auth gate. A pruned sidecar transcript is the ordinary trigger.
  //
  // It is also the module's own rule applied to its last unguarded branch: a
  // dispatch we cannot place is still a dispatch that demonstrably ran, and
  // "I could not place it" is not "it did not happen". Twelve lines below, a
  // *prescribed* record with no timestamp already returned unavailable rather
  // than pretending it was absent; this branch silently did the opposite.
  const configDir = plantHost({
    lines: PARENT,
    subagents: { a1: { meta: meta({ description: 'ordinary implementer work' }), lines: [] } },
  });

  const result = reviewEvidence({
    session: boundSession(),
    now: () => new Date('2026-07-28T12:00:00.000Z'),
    configDir,
  });

  assert.equal(result.available, true, 'an unlabelled dispatch is not a reason to give up');
  assert.equal(result.seen, 1, 'it ran; we just cannot say when');
  assert.equal(result.prescribed, 0);
  // `seen > 0, prescribed === 0` is the adoption gate's "convention not in use"
  // row, so the census falls back to prose — the side that cannot refuse work.
  assert.deepEqual(plain(result.units), {});
});

// ---------------------------------------------------------------------------
// Attribution by name (F31 / C1, closed structurally)
//
// A dispatch record names the Forge session that made it, so crediting one is
// an equality test. Three review rounds each found a fresh way for the previous
// design — "a review dispatch somewhere in this host conversation while this
// session was open" — to credit a neighbour's reviewer to a session whose own
// review file said the coordinator wrote it: a window a later session's
// dispatch still landed inside, a `forge cleanup` that erased the neighbour's
// `session.json`, and a ledger line predating the field that recorded which
// conversation a session ran in. All three were the money/auth gate passing on
// someone else's evidence, and all three are gone with the inference.
// ---------------------------------------------------------------------------

test("a neighbour's reviewer in the same conversation is not this session's", () => {
  const configDir = plantHost({
    lines: PARENT,
    subagents: {
      a1: {
        meta: meta({ description: 'forge-review final 20260728T113000Z-neighbour-def456' }),
        lines: [assistantLine({ requestId: 'rev_1', at: '2026-07-28T11:30:00.000Z' })],
      },
    },
  });

  const result = reviewEvidence({ session: boundSession(), configDir });

  // Available and measured: we looked, and nothing here was dispatched for us.
  assert.equal(result.available, true);
  assert.deepEqual(plain(result.units), {}, "a neighbour's reviewer must not appear in our units");
  assert.equal(result.prescribed, 0, 'nothing was dispatched for this session');
  // It still counts as a dispatch that happened, which is what stops the census
  // reading this as "nothing ran at all" and refusing the work.
  assert.equal(result.seen, 1);
});

test('the same dispatch counts when it names this session', () => {
  // The discriminating half of the case above: identical fixture, one string
  // different. Without this the test above would pass against a reader that
  // credits nobody.
  const configDir = plantHost({
    lines: PARENT,
    subagents: {
      a1: {
        meta: meta({ description: `forge-review final ${DEMO_ID}` }),
        lines: [assistantLine({ requestId: 'rev_1', at: '2026-07-28T11:30:00.000Z' })],
      },
    },
  });

  const result = reviewEvidence({ session: boundSession(), configDir });

  assert.equal(result.available, true);
  assert.deepEqual(plain(result.units), {
    final: { dispatched: 1, stopped: 0, requests: 1, maxRequests: 1 },
  });
  assert.equal(result.prescribed, 1);
});

test('a dispatch outside the old window still counts when it names this session', () => {
  // The window is gone, and this pins that it is gone. A reviewer dispatched
  // hours before this session was created — a clock skew, a resumed
  // conversation — used to be discarded as "provably somebody else's", which
  // meant a session whose reviewer really ran read as `self` and refused.
  const configDir = plantHost({
    lines: PARENT,
    subagents: {
      a1: {
        meta: meta({ description: `forge-review final ${DEMO_ID}` }),
        lines: [assistantLine({ requestId: 'rev_1', at: '2026-07-27T03:00:00.000Z' })],
      },
    },
  });

  const result = reviewEvidence({
    session: boundSession({ createdAt: '2026-07-28T10:00:00.000Z' }),
    configDir,
  });

  assert.deepEqual(plain(result.units), {
    final: { dispatched: 1, stopped: 0, requests: 1, maxRequests: 1 },
  });
});

test('a review dispatch naming no session is unattributable, not absent', () => {
  // The older two-word form. It cannot be credited to this session, and it
  // cannot be dismissed either — it may well be ours. Both resolutions are
  // defects this module has already shipped once each, so the answer is that we
  // cannot tell, and the census reads the prose instead.
  const configDir = plantHost({
    lines: PARENT,
    subagents: {
      a1: {
        meta: meta({ description: 'forge-review final' }),
        lines: [assistantLine({ requestId: 'rev_1', at: '2026-07-28T10:30:00.000Z' })],
      },
    },
  });

  const result = reviewEvidence({ session: boundSession(), configDir });

  assert.equal(result.available, false);
  assert.match(result.reason, /names no Forge session/i);
  assert.deepEqual(plain(result.units), {});
});

test('reviewEvidence cannot match a dispatch to a session with no id', () => {
  const configDir = plantHost({ lines: PARENT, subagents: {} });

  const result = reviewEvidence({
    session: { createdAt: '2026-07-28T10:00:00.000Z', host: { sessionIds: [HOST_ID] } },
    configDir,
  });

  assert.equal(result.available, false);
  assert.match(result.reason, /no id/i);
});

test('an unreadable dispatch is unavailability wherever it sits', () => {
  // Formerly one whose transcript placed it outside the window was skipped as
  // provably a neighbour's. With no window there is nothing to prove that with,
  // and the meta we cannot read may be this session's own final reviewer —
  // which, once any of our dispatches is on record, refuses the change.
  const configDir = plantHost({
    lines: PARENT,
    subagents: {
      a1: {
        meta: meta({ description: `forge-review group-01 ${DEMO_ID}` }),
        lines: [assistantLine({ requestId: 'g_1', at: '2026-07-28T10:30:00.000Z' })],
      },
      a2: { meta: '{ not json', lines: [assistantLine({ requestId: 'x', at: '2026-07-25T01:00:00.000Z' })] },
    },
  });

  const result = reviewEvidence({ session: boundSession(), configDir });

  assert.equal(result.available, false);
  assert.match(result.reason, /cannot tell whether it was this session's reviewer/i);
});
