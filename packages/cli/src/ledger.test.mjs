import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { appendDeferralLedger, appendSessionDigest, readLedger } from './ledger.mjs';
import { CENSUS_RULE, reviewCensus } from './review-census.mjs';
import { frozenReviewVerdict } from './review-verdict.mjs';

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

/** A metrics.json as the collector writes it, with derivable totals. */
function metricsDoc({ tokens, subagents = [], models = null } = {}) {
  return {
    available: true,
    collectedAt: '2026-07-25T14:30:00.000Z',
    source: { agent: 'claude-code', hostVersion: '2.1.220', transcripts: ['/t.jsonl'], sidecars: subagents.length },
    window: { from: '2026-07-25T08:00:00.000Z', to: '2026-07-25T14:30:00.000Z' },
    requests: 21,
    tokens,
    // Deliberately not in sorted order: the digest sorts so a diff of two
    // ledger lines is about the numbers, not about hash iteration order.
    byModel: models ?? {
      'claude-opus-5': { requests: 20, ...tokens },
      'claude-fable-5': { requests: 1, input: 1, output: 1, cacheRead: 1, cacheCreate: 1 },
    },
    byPhase: { implement: { requests: 21, ...tokens } },
    tools: { Bash: { calls: 9, errors: 1 }, Read: { calls: 11, errors: 0 } },
    errors: { toolResults: 20, errorResults: 1, rate: 0.05 },
    subagents,
    breakdown: { parent: { requests: 21, tokens }, subagents: { requests: 0, tokens } },
  };
}

function writeMetrics(sessionDir, doc) {
  fs.writeFileSync(
    path.join(sessionDir, 'metrics.json'),
    typeof doc === 'string' ? doc : `${JSON.stringify(doc, null, 2)}\n`,
    'utf8',
  );
}

function digestOf(root) {
  return readLedger(path.join(root, '.forge', 'sessions.jsonl'))[0];
}

test('the digest carries compact metrics totals, so they survive cleanup', () => {
  const root = tmp('forge-ledger-metrics-');
  const { sessionDir, session } = makeSession(root, 's1', { subagentsDispatched: null });
  const tokens = { input: 1207, output: 7451, cacheRead: 355006, cacheCreate: 1171 };
  const doc = metricsDoc({
    tokens,
    subagents: [
      { agentId: 'a1', agentType: 'general-purpose', requests: 4 },
      { agentId: 'a2', agentType: 'Explore', requests: 2 },
    ],
  });
  writeMetrics(sessionDir, doc);

  appendSessionDigest({ cwd: root, sessionDir, session, card: { score: 88, grade: 'B' } });
  fs.rmSync(sessionDir, { recursive: true, force: true });
  const entry = digestOf(root);

  assert.equal(entry.metrics.available, true);
  assert.equal(entry.metrics.requests, doc.requests);
  assert.equal(entry.metrics.outputTokens, tokens.output);
  assert.equal(
    entry.metrics.totalTokens,
    Object.values(tokens).reduce((a, b) => a + b, 0),
    'cache reads are the bulk of a long session — a digest must not report only input+output',
  );
  assert.deepEqual(entry.metrics.models, Object.keys(doc.byModel).slice().sort());
  assert.equal(entry.metrics.errorRate, doc.errors.rate);
  assert.equal(entry.metrics.subagents, doc.subagents.length);
  assert.equal(entry.subagentsDispatched, doc.subagents.length);

  // Totals only: the whole point of the ledger is one readable line per
  // session, and byPhase/tools/per-subagent records stay in metrics.json.
  assert.deepEqual(Object.keys(entry.metrics).sort(), [
    'available',
    'errorRate',
    'models',
    'outputTokens',
    'requests',
    'subagents',
    'totalTokens',
  ]);
});

test('a measured subagent count supersedes the hand-maintained one', () => {
  // `--subagents N` is bookkeeping a coordinator maintains by hand, and the
  // live ledger holds `null, null, 0` for three sessions that certainly
  // dispatched. metrics.subagents is counted from the host's own sidecars.
  const root = tmp('forge-ledger-metrics-sub-');
  const { sessionDir, session } = makeSession(root, 's1', { subagentsDispatched: 0 });
  const doc = metricsDoc({
    tokens: { input: 1, output: 2, cacheRead: 3, cacheCreate: 4 },
    subagents: [{ agentId: 'a1', requests: 4 }, { agentId: 'a2', requests: 1 }, { agentId: 'a3', requests: 9 }],
  });
  writeMetrics(sessionDir, doc);

  appendSessionDigest({ cwd: root, sessionDir, session, card: null });
  assert.equal(digestOf(root).subagentsDispatched, doc.subagents.length);
});

test('a session with no metrics.json still writes a line, and invents no dispatch count', () => {
  // `0` would read as "no subagents ran", which is a measurement nobody made.
  const root = tmp('forge-ledger-nometrics-');
  const { sessionDir, session } = makeSession(root, 's1', { subagentsDispatched: null });
  appendSessionDigest({ cwd: root, sessionDir, session, card: { score: 70, grade: 'C' } });

  const entry = digestOf(root);
  assert.deepEqual(entry.metrics, { available: false });
  assert.equal(entry.subagentsDispatched, null);
  assert.equal(entry.score, 70, 'the rest of the line is unaffected');
});

test('with no metrics the hand-maintained dispatch count is still carried', () => {
  const root = tmp('forge-ledger-nometrics-declared-');
  const { sessionDir, session } = makeSession(root, 's1', { subagentsDispatched: 12 });
  appendSessionDigest({ cwd: root, sessionDir, session, card: null });
  assert.equal(digestOf(root).subagentsDispatched, 12);
});

test('the digest carries how often the model policy had to correct a dispatch', () => {
  // Cheap to keep and impossible to reconstruct later: the dispatch ledger dies
  // with the session directory, and skip rate is the number this whole change
  // was commissioned to produce.
  const root = tmp('forge-ledger-dispatches-');
  const { sessionDir, session } = makeSession(root, 's1', { subagentsDispatched: null });
  const dispatches = { total: 9, allowed: 6, rewritten: 2, denied: 1, skipped: 3 };
  writeMetrics(sessionDir, { ...metricsDoc({ tokens: { output: 1 } }), dispatches });

  appendSessionDigest({ cwd: root, sessionDir, session, card: null });
  const entry = digestOf(root);
  assert.equal(entry.dispatchesSkipped, dispatches.skipped);
  assert.deepEqual(
    entry.dispatches,
    dispatches,
    'a skip count with no denominator cannot become a skip rate once the session dir is gone',
  );
});

test('a degraded document still yields a measured dispatch count', () => {
  // dispatches.jsonl is Forge's own file, so an unbound session — or one whose
  // host transcript was pruned — still knows precisely what it dispatched. Two
  // numbers survive where previously neither did: how many dispatches the
  // policy corrected, and how many subagents actually ran (everything the hook
  // saw except the ones it refused).
  const root = tmp('forge-ledger-dispatches-degraded-');
  const { sessionDir, session } = makeSession(root, 's1', { subagentsDispatched: null });
  const dispatches = { total: 9, allowed: 6, rewritten: 2, denied: 1, skipped: 3 };
  writeMetrics(sessionDir, { available: false, reason: 'no transcript on disk', dispatches });

  appendSessionDigest({ cwd: root, sessionDir, session, card: null });
  const entry = digestOf(root);
  assert.deepEqual(entry.metrics, { available: false });
  assert.equal(entry.dispatchesSkipped, 3);
  assert.equal(
    entry.subagentsDispatched,
    dispatches.allowed + dispatches.rewritten,
    'a denied dispatch never became a subagent',
  );
});

test('a sidecar count beats a dispatch-derived one, and both beat the declared figure', () => {
  const root = tmp('forge-ledger-dispatch-precedence-');
  const { sessionDir, session } = makeSession(root, 's1', { subagentsDispatched: 99 });
  writeMetrics(sessionDir, {
    ...metricsDoc({
      tokens: { output: 1 },
      subagents: [{ agentId: 'a1' }, { agentId: 'a2' }],
    }),
    dispatches: { total: 7, allowed: 7, rewritten: 0, denied: 0, skipped: 0 },
  });

  appendSessionDigest({ cwd: root, sessionDir, session, card: null });
  assert.equal(
    digestOf(root).subagentsDispatched,
    2,
    'sidecars are direct evidence a subagent ran; the hook only saw it dispatched',
  );
});

test('a session with no dispatch counts at all says so, rather than claiming zero', () => {
  const root = tmp('forge-ledger-nodispatches-');
  const { sessionDir, session } = makeSession(root, 's1', { subagentsDispatched: 4 });
  writeMetrics(sessionDir, metricsDoc({ tokens: { output: 1 } })); // pre-4.2 document

  appendSessionDigest({ cwd: root, sessionDir, session, card: null });
  assert.equal(digestOf(root).dispatchesSkipped, null, 'never measured is not the same as zero');
});

test('a corrupt or degraded metrics.json does not lose the digest line', () => {
  for (const [label, content] of [
    ['half-written', '{"available": true, "tokens": {"in'],
    ['not an object', '"metrics"'],
    ['degraded', `${JSON.stringify({ available: false, reason: 'no transcript on disk' })}\n`],
    ['available but empty', `${JSON.stringify({ available: true })}\n`],
  ]) {
    const root = tmp('forge-ledger-badmetrics-');
    const { sessionDir, session } = makeSession(root, 's1', { subagentsDispatched: 7 });
    writeMetrics(sessionDir, content);

    assert.equal(appendSessionDigest({ cwd: root, sessionDir, session, card: null }), 1, label);
    const entry = digestOf(root);
    assert.equal(entry.sessionId, 's1', label);
    if (label === 'available but empty') {
      // A document that says available with nothing in it is reported as zeros,
      // not as a crash and not as a missing line.
      assert.equal(entry.metrics.available, true, label);
      assert.equal(entry.metrics.totalTokens, 0, label);
      assert.deepEqual(entry.metrics.models, [], label);
      assert.equal(entry.subagentsDispatched, 0, label);
    } else {
      assert.deepEqual(entry.metrics, { available: false }, label);
      assert.equal(entry.subagentsDispatched, 7, label);
    }
  }
});

test('readLedger tolerates a truncated or corrupt line', () => {
  const root = tmp('forge-ledger-corrupt-');
  const file = path.join(root, 'x.jsonl');
  fs.writeFileSync(file, '{"a":1}\n{ broken\n{"a":2}\n', 'utf8');
  assert.deepEqual(readLedger(file), [{ a: 1 }, { a: 2 }]);
});

test('a malformed dispatch block reads as zeros, never as two different answers', () => {
  // `null` means no dispatch block was ever written. Once one exists, a missing
  // key inside it is a zero — the flat field and the block must not disagree.
  const root = tmp('forge-ledger-dispatch-malformed-');
  const { sessionDir, session } = makeSession(root, 's1', { subagentsDispatched: null });
  writeMetrics(sessionDir, { ...metricsDoc({ tokens: { output: 1 } }), dispatches: {} });

  appendSessionDigest({ cwd: root, sessionDir, session, card: null });
  const entry = digestOf(root);
  assert.equal(entry.dispatchesSkipped, entry.dispatches.skipped);
  assert.equal(entry.dispatchesSkipped, 0);
});

test('a declined reviewer survives cleanup, as set-phase promises it does', () => {
  // enforceFinalReviewFloor tells the operator the waiver is "kept on the
  // session and in .forge/sessions.jsonl". It was kept only on the session, so
  // the reason a reviewer was declined vanished with the directory while the
  // cap it explains lived on in the score.
  const root = tmp('forge-ledger-waiver-');
  const { sessionDir, session } = makeSession(root, 's1', {
    finalReviewWaived: 'operator declined dispatch twice',
  });

  appendSessionDigest({ cwd: root, sessionDir, session, card: null });
  fs.rmSync(sessionDir, { recursive: true, force: true });

  assert.equal(digestOf(root).finalReviewWaived, 'operator declined dispatch twice');
});

test('a session with no waiver records null, not an empty claim', () => {
  const root = tmp('forge-ledger-nowaiver-');
  const { sessionDir, session } = makeSession(root, 's1');
  appendSessionDigest({ cwd: root, sessionDir, session, card: null });
  assert.equal(digestOf(root).finalReviewWaived, null);
});

/** A final review the prose rule reads as self-authored. */
const SELF_PROSE = '# Final review\n\nReviewer: the coordinator — a self-check of the diff.\n';

/** A final review the prose rule reads as written by an outside reader. */
const INDEPENDENT_PROSE =
  '# Final review\n\n**Verdict: APPROVED** — opus reviewer 4d2 read the whole diff.\n';

/** @param {string} sessionDir @param {string} body */
function writeFinalReview(sessionDir, body) {
  fs.mkdirSync(path.join(sessionDir, 'reviews'), { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'reviews', 'final-review.md'), body, 'utf8');
}

test('the digest records the frozen verdict, not a fresh reading of the review file', () => {
  // The verdict was measured from the host's dispatch record at the transition
  // and written onto the session. By the time anything reads the digest back,
  // that evidence may be gone — measured: a one-day-old session on this machine
  // already has no surviving host transcript. Re-reading the file here would
  // hand the verdict back to the party being judged.
  const root = tmp('forge-ledger-frozen-');
  const { sessionDir, session } = makeSession(root, 's1', {
    reviewVerdict: { final: 'independent', evidence: 'host', stoppedByOperator: false },
  });
  writeFinalReview(sessionDir, SELF_PROSE);

  // Discriminating fixture: the prose says the opposite of the frozen verdict.
  assert.equal(reviewCensus(sessionDir).finalReview, 'self', 'fixture: prose alone says self');

  appendSessionDigest({ cwd: root, sessionDir, session, card: null });
  const { reviews } = digestOf(root);
  assert.equal(reviews.final, 'independent');
  assert.equal(reviews.evidence, 'host');
  assert.equal(reviews.rule, CENSUS_RULE);
});

test('a declined reviewer is reported in the record that outlives the session', () => {
  // The spec requires a stopped dispatch to be surfaced, and the session
  // directory — where the census computed it — is deleted at cleanup. Recorded
  // beside `evidence` because the flag is a measurement only under `host`; on
  // any other grade it is a placeholder, exactly as `reviewCensus` documents.
  const root = tmp('forge-ledger-frozen-stopped-');
  const { sessionDir, session } = makeSession(root, 's1', {
    reviewVerdict: { final: 'self', evidence: 'host', stoppedByOperator: true },
  });
  appendSessionDigest({ cwd: root, sessionDir, session, card: null });
  const { reviews } = digestOf(root);
  assert.equal(reviews.final, 'self');
  assert.equal(reviews.evidence, 'host');
  assert.equal(reviews.stoppedByOperator, true);

  // The control: same grade, same verdict, no stop. Without it the assertion
  // above cannot tell a carried flag from a hard-coded one.
  const quiet = tmp('forge-ledger-frozen-unstopped-');
  const pair = makeSession(quiet, 's1', {
    reviewVerdict: { final: 'self', evidence: 'host', stoppedByOperator: false },
  });
  appendSessionDigest({ cwd: quiet, sessionDir: pair.sessionDir, session: pair.session, card: null });
  assert.equal(digestOf(quiet).reviews.stoppedByOperator, false);
});

test('a frozen "there is no final review" is not re-read from a file that appeared later', () => {
  // The commonest frozen shape by a wide margin — 12 of the 20 real sessions
  // behind this change — and the one where a fallback that ignores `null` is
  // invisible: `frozenReviewVerdict` must read an explicit `null` verdict as a
  // verdict, not as a missing field, or the digest quietly re-reads the file
  // and reports a review the session did not have when it was measured.
  const root = tmp('forge-ledger-frozen-none-');
  const { sessionDir, session } = makeSession(root, 's1', {
    reviewVerdict: { final: null, evidence: 'none', stoppedByOperator: false },
  });
  writeFinalReview(sessionDir, INDEPENDENT_PROSE);
  assert.equal(
    reviewCensus(sessionDir).finalReview,
    'independent',
    'fixture: prose alone says independent, so a re-read would be visible',
  );

  appendSessionDigest({ cwd: root, sessionDir, session, card: null });
  const { reviews } = digestOf(root);
  assert.equal(reviews.final, null);
  assert.equal(reviews.evidence, 'none');
});

test('a session with no frozen verdict falls back to a live census, graded inferred', () => {
  // Every session that finished before this change. The digest must still
  // carry a verdict and must say plainly how it was reached.
  const root = tmp('forge-ledger-nofrozen-');
  const { sessionDir, session } = makeSession(root, 's1');
  writeFinalReview(sessionDir, SELF_PROSE);

  appendSessionDigest({ cwd: root, sessionDir, session, card: null });
  const { reviews } = digestOf(root);
  assert.equal(reviews.final, reviewCensus(sessionDir).finalReview);
  assert.equal(reviews.evidence, 'inferred');
});

test('frozenReviewVerdict answers null for anything that is not a session object', () => {
  // Lives here rather than in its own file so the group's tier-2 command still
  // covers it. `frozenReviewVerdict` documents "never throws" and every caller
  // is on the `forge phase done` path, but the whole promise rests on one
  // guard: without it, reading `.reviewVerdict` off a string is merely
  // undefined while reading it off `null` throws — and that throw would land
  // inside the done gate, which has no try/catch of its own.
  for (const notASession of [null, undefined, 'session', 42, true, Symbol('s')]) {
    assert.equal(frozenReviewVerdict(notASession), null, String(notASession));
  }
  assert.equal(frozenReviewVerdict({}), null, 'a session with no verdict on it');
});

test('a legacy session with no final review at all is graded none, never inferred', () => {
  // The fallback path's own absence case, and the one place this change could
  // still have left an absence wearing a grade: `inferred` asserts that the
  // review file's prose was read and produced this verdict, and there was no
  // prose to read. The consequence is small — `fleet-report` ignores lines with
  // no verdict — which is exactly why it is not the place to make an exception.
  const root = tmp('forge-ledger-nofrozen-nofile-');
  const { sessionDir, session } = makeSession(root, 's1');
  assert.equal(reviewCensus(sessionDir).finalReview, null, 'fixture: no final review to judge');

  appendSessionDigest({ cwd: root, sessionDir, session, card: null });
  const { reviews } = digestOf(root);
  assert.equal(reviews.final, null);
  assert.equal(reviews.evidence, 'none');
});

test('a reviewVerdict that is not the shape set-phase writes falls back to a live census', () => {
  // A hand-edited or half-written field is not a measurement, and a partial one
  // read generously would put an invented verdict into the record that outlives
  // the session — and, through the same reader, in front of the done gate.
  const live = (dir) => ({ final: reviewCensus(dir).finalReview, evidence: 'inferred' });
  for (const [label, reviewVerdict] of [
    ['not an object', 'independent'],
    ['an array', ['independent']],
    ['no evidence grade', { final: 'independent', stoppedByOperator: false }],
    ['an unknown grade', { final: 'independent', evidence: 'vibes', stoppedByOperator: false }],
    ['an unknown verdict', { final: 'probably', evidence: 'host', stoppedByOperator: false }],
    ['a missing verdict', { evidence: 'host', stoppedByOperator: false }],
    ['a non-boolean flag', { final: 'independent', evidence: 'host', stoppedByOperator: 'no' }],
  ]) {
    const root = tmp('forge-ledger-badfrozen-');
    const { sessionDir, session } = makeSession(root, 's1', { reviewVerdict });
    writeFinalReview(sessionDir, SELF_PROSE);
    const expected = live(sessionDir);
    // The fixture discriminates: the prose verdict differs from the one the
    // malformed field claims, so accepting it would be visible here.
    assert.notEqual(expected.final, 'independent', label);

    appendSessionDigest({ cwd: root, sessionDir, session, card: null });
    const { reviews } = digestOf(root);
    assert.equal(reviews.final, expected.final, label);
    assert.equal(reviews.evidence, expected.evidence, label);
  }
});

test('the digest records which census rule judged its reviews', () => {
  const root = tmp('forge-ledger-censusrule-');
  const { sessionDir, session } = makeSession(root, 's1');
  fs.mkdirSync(path.join(sessionDir, 'reviews'), { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'reviews', 'final-review.md'),
    'Reviewer: claude-opus-5 (final-reviewer)\n\nREADY\n',
    'utf8',
  );

  appendSessionDigest({ cwd: root, sessionDir, session, card: null });
  const entry = digestOf(root);
  assert.equal(entry.reviews.rule, CENSUS_RULE);
  assert.equal(entry.reviews.final, 'independent');
});
