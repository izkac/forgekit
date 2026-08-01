import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  formatScorecardMarkdown,
  gradeForScore,
  reviewCoverageCap,
  scoreSession,
  writeSessionScorecard,
} from './score.mjs';
import { e2eStepsHash } from './integrity.mjs';
import { collectPlanFacts } from './plan-facts.mjs';

const PHASE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'set-phase.mjs');
const SCORE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'score-cli.mjs');
const CLEANUP_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cleanup-sessions.mjs');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

function makeSession(root, overrides = {}) {
  const sessionDir = path.join(root, '.forge', 'sessions', 'sess-score');
  fs.mkdirSync(sessionDir, { recursive: true });
  const now = new Date().toISOString();
  const session = {
    id: 'sess-score',
    slug: 'fixture',
    createdAt: now,
    updatedAt: now,
    phase: 'verify',
    planType: null,
    openspecChange: null,
    tasksTotal: 2,
    tasksComplete: 2,
    pace: 'auto',
    resolvedPace: 'standard',
    pacePinned: false,
    ...overrides,
  };
  fs.writeFileSync(path.join(sessionDir, 'session.json'), `${JSON.stringify(session, null, 2)}\n`, 'utf8');
  fs.writeFileSync(
    path.join(root, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId: 'sess-score' }, null, 2)}\n`,
    'utf8',
  );
  return { sessionDir, session };
}

function validSpine(rows) {
  return {
    change: null,
    notApplicable: null,
    rows,
  };
}

function validRow() {
  return {
    capability: 'REQ-GOV-01 matching',
    library: 'etl_core/matcher.py',
    runtimeOwner: 'worker job analyze_study',
    writes: 'study_proposals',
    reads: 'N/A',
    uiConsumer: 'Proposals',
    evidence: 'tasks/12/test-evidence.md',
  };
}

test('gradeForScore bands', () => {
  assert.equal(gradeForScore(95), 'A');
  assert.equal(gradeForScore(80), 'B');
  assert.equal(gradeForScore(60), 'C');
  assert.equal(gradeForScore(40), 'D');
  assert.equal(gradeForScore(10), 'F');
});

test('scoreSession: strong sync-only session scores high', () => {
  const root = tmp('forge-score-strong-');
  try {
    const { sessionDir, session } = makeSession(root, { slug: 'add-health' });
    fs.writeFileSync(
      path.join(sessionDir, 'spine.json'),
      `${JSON.stringify({ rows: [], notApplicable: 'sync HTTP only' }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# Verify\n\nExit 0\n', 'utf8');
    const taskDir = path.join(sessionDir, 'tasks', '01-health');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, 'test-evidence.md'),
      '# Test evidence\n\n- **Exit code:** 0\n- **Summary:** assert response.ok === true\n',
      'utf8',
    );

    const card = scoreSession({ cwd: root, sessionDir, session });
    assert.ok(card.score >= 80, `expected >=80, got ${card.score}`);
    assert.ok(['A', 'B'].includes(card.grade));
    assert.equal(card.integrityOk, true);
    assert.match(formatScorecardMarkdown(card), /Grade: [AB]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** Session with everything except reviews, so review depth is the only variable. */
function makeReviewFixture(root, sessionOverrides = {}) {
  const { sessionDir, session } = makeSession(root, {
    slug: 'add-billing',
    tasksTotal: 20,
    tasksComplete: 20,
    ...sessionOverrides,
  });
  fs.writeFileSync(
    path.join(sessionDir, 'spine.json'),
    `${JSON.stringify({ rows: [], notApplicable: 'sync HTTP only' }, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# Verify\n\nExit 0\n', 'utf8');
  const taskDir = path.join(sessionDir, 'tasks', '01-model');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, 'test-evidence.md'),
    '# Test evidence\n\n- **Exit code:** 0\n- **Summary:** asserts the row is written\n',
    'utf8',
  );
  return { sessionDir, session, taskDir };
}

function reviewCheck(card) {
  return card.checks.find((c) => c.id === 'reviews');
}

test('review depth: no reviewer artifacts at all scores zero, not full marks', () => {
  // Regression: reviewPts started at 5 and was only ever *reduced* by finding
  // self-check markers, so a session with no reviews of any kind scored 5/5.
  // That is how a 38-task, high-risk, self-reviewed session reached 100/100.
  const root = tmp('forge-score-noreview-');
  try {
    const { sessionDir, session } = makeReviewFixture(root);
    const check = reviewCheck(scoreSession({ cwd: root, sessionDir, session }));
    assert.equal(check.points, 0);
    assert.match(check.notes.join(' '), /no review/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * F13 (this change) — a session with no reviews of any kind must be capped,
 * not merely docked 5 review points. 0.3.25 (reverted in 0.3.26) tried this
 * and shipped it backwards: its guard read `reviewUnits`, a variable assigned
 * only in the has-at-least-one-review branch, so a session with *zero*
 * reviews always failed `reviewUnits >= 3` and scored uncapped, while a
 * session with one thin review met the guard and was capped — the exact
 * session the cap existed to catch was the one it could never see.
 *
 * Deliberately non-money/auth wording throughout (slug, paceSignal, spine):
 * `makeReviewFixture`'s default slug is `'add-billing'`, which trips a
 * SEPARATE, pre-existing high-risk final-review cap at 69
 * (`isHighRiskText` / `THOROUGH_RE` in preferences.mjs). Building on that slug
 * would let this test pass for the wrong reason — the high-risk floor doing
 * the work, not the review-coverage cap this test exists to pin. The
 * assertion right after the fixture is that trap-check: it fails loudly if
 * the fixture is accidentally high-risk, before the real assertion below it
 * ever runs.
 */
test('review depth: zero reviews of any kind caps a strong session at 69 (F13)', () => {
  const root = tmp('forge-score-zero-review-cap-');
  try {
    const { sessionDir, session } = makeReviewFixture(root, {
      slug: 'telemetry-dashboard-rollup',
      paceSignal: 'aggregate nightly dashboard telemetry counts',
      resolvedPace: 'thorough',
      tasksTotal: 6,
      tasksComplete: 6,
    });

    const card = scoreSession({ cwd: root, sessionDir, session });

    // Trap check (see comment above): this fixture must not be high-risk, so
    // any cap seen below can only be the F13 review-coverage cap, never the
    // unrelated money/auth floor.
    assert.equal(
      card.caps.some((c) => /independent final review|self-authored/i.test(capText(c))),
      false,
      `fixture must not trip the unrelated high-risk cap: ${capsJoin(card.caps) || '(none)'}`,
    );

    assert.ok(card.score <= 69, `expected a cap at 69, got ${card.score}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * F13's paired regression: the exact pair 0.3.25 inverted. Two sessions
 * identical except for review artifacts — one with none, one with a single
 * independent per-group review — and review coverage must never make the
 * score worse. This is the invariant 0.3.25's `reviewUnits` bug broke (see
 * the test above): its cap fired for the reviewed session and never for the
 * unreviewed one, so *more* review scored *worse*.
 *
 * Measured, not assumed (brief numbers are illustrative only): against
 * today's checkout — which has no review-coverage cap of any kind, F13 or
 * 0.3.25's, both fully absent since the 0.3.26 revert — this assertion holds
 * trivially, because with no cap in play a review file can only ever add
 * points, never remove them. I confirmed the assertion is not vacuous by
 * temporarily reintroducing the exact 0.3.25 cap block (from
 * `git show c031fdc:packages/cli/src/score.mjs`) into a scratch copy of
 * score.mjs and re-running an equivalent fixture pair with 6 physical task
 * groups: it reproduced the historical inversion exactly (95 uncapped vs 69
 * capped), then I reverted the file by hand (`git diff` clean afterward) —
 * see the task report for the transcript. So this pins a real invariant; it
 * just is not the half of this batch that runs red before F13 lands.
 */
test('review depth: more review must never score worse than less (0.3.25 inversion regression)', () => {
  const rootA = tmp('forge-score-inversion-zero-');
  const rootB = tmp('forge-score-inversion-one-');
  try {
    const zeroFixture = makeReviewFixture(rootA, {
      slug: 'telemetry-dashboard-rollup',
      paceSignal: 'aggregate nightly dashboard telemetry counts',
      resolvedPace: 'thorough',
      tasksTotal: 6,
      tasksComplete: 6,
    });
    const zeroReview = scoreSession({
      cwd: rootA,
      sessionDir: zeroFixture.sessionDir,
      session: zeroFixture.session,
    });

    const oneFixture = makeReviewFixture(rootB, {
      slug: 'telemetry-dashboard-rollup',
      paceSignal: 'aggregate nightly dashboard telemetry counts',
      resolvedPace: 'thorough',
      tasksTotal: 6,
      tasksComplete: 6,
    });
    fs.writeFileSync(
      path.join(oneFixture.taskDir, 'group-review.md'),
      '# Group review\n\n**Verdict: APPROVED** (opus reviewer 7c1)\n',
      'utf8',
    );
    const oneReview = scoreSession({ cwd: rootB, sessionDir: oneFixture.sessionDir, session: oneFixture.session });

    assert.ok(
      zeroReview.score <= oneReview.score,
      `zero-review session (${zeroReview.score}) must never score worse than the one-review session (${oneReview.score})`,
    );
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});

/**
 * Direct unit tests for `reviewCoverageCap` — no session directory, just the
 * function. Task 2.1's six branches: rules 1-5 plus the malformed-census
 * guard. Every test below also asserts a NON-null result somewhere (either
 * directly, for the two capping rules, or via a "witness" call that flips one
 * field back to a capping shape) so that a stub which always returns `null`
 * fails at least one assertion in every one of these tests — several of the
 * six branches expect `null` as the *correct* answer, and without a witness
 * those would pass against such a stub for the wrong reason.
 */

test('reviewCoverageCap: rule 1 — only applies when the effective review.perTask knob prescribes per-group reviewers', () => {
  // Gates on the KNOB (`review.perTask`), not the pace: `review.perTask` is an
  // independently overridable setting (preferences.mjs) — `forge prefs --
  // --set review.perTask=never` sets it at ANY pace. `reviewCoverageCap` stays
  // pure — no filesystem access — so `perTaskReview` arrives pre-resolved as a
  // parameter; the call site (`scoreSession`) is responsible for resolving it
  // via `resolveEffectivePreferences`. The four paces still map onto these
  // knob values 1:1 (thorough->always, standard->per-group,
  // brisk->high-risk-only, lite->never), so this subsumes the old pace check
  // for any session that never touched the knob.
  const census = { independent: 0, finalReview: null };
  for (const knob of ['high-risk-only', 'never', undefined, null, 'bogus']) {
    assert.equal(
      reviewCoverageCap({ census, perTaskReview: knob, tasks: 10 }),
      null,
      `perTaskReview=${knob} must not cap`,
    );
  }
  // Witness: flipping only the knob to 'per-group' must cap. Proves the nulls
  // above came from the knob guard, not from a stub that always returns null.
  assert.notEqual(reviewCoverageCap({ census, perTaskReview: 'per-group', tasks: 10 }), null);
});

test('reviewCoverageCap: rule 1b — both knob values that prescribe per-group reviewers ("always", "per-group") cap', () => {
  const census = { independent: 0, finalReview: null };
  assert.notEqual(reviewCoverageCap({ census, perTaskReview: 'always', tasks: 10 }), null);
  assert.notEqual(reviewCoverageCap({ census, perTaskReview: 'per-group', tasks: 10 }), null);
});

test('reviewCoverageCap: rule 2 — only applies at 5+ tasks', () => {
  const census = { independent: 0, finalReview: null };
  assert.equal(reviewCoverageCap({ census, perTaskReview: 'per-group', tasks: 4 }), null);
  assert.equal(reviewCoverageCap({ census, perTaskReview: 'always', tasks: 0 }), null);
  // Witness: same census and knob, tasks raised to 5 must cap.
  assert.notEqual(reviewCoverageCap({ census, perTaskReview: 'per-group', tasks: 5 }), null);
});

test('reviewCoverageCap: rule 3 — zero independent reviews with no independent final review caps at 69', () => {
  const noFinal = reviewCoverageCap({
    census: { independent: 0, finalReview: null },
    perTaskReview: 'per-group',
    tasks: 6,
  });
  assert.equal(noFinal.cap, 69);
  assert.match(noFinal.reason, /per-group review/i);

  const selfFinal = reviewCoverageCap({
    census: { independent: 0, finalReview: 'self' },
    perTaskReview: 'always',
    tasks: 6,
  });
  assert.equal(selfFinal.cap, 69, 'a self-authored final review is not an independent one — same tier');
});

test('reviewCoverageCap: rule 4 — an independent final review softens the cap to 89, with distinguishable wording', () => {
  const noFinal = reviewCoverageCap({
    census: { independent: 0, finalReview: null },
    perTaskReview: 'per-group',
    tasks: 6,
  });
  const independentFinal = reviewCoverageCap({
    census: { independent: 0, finalReview: 'independent' },
    perTaskReview: 'per-group',
    tasks: 6,
  });
  assert.equal(independentFinal.cap, 89);
  assert.notEqual(
    noFinal.reason,
    independentFinal.reason,
    'a reader must be able to tell "nobody read this" from "an independent final review exists" from the wording alone',
  );
});

test('reviewCoverageCap: rule 5 — any independent per-group review lifts the cap entirely', () => {
  assert.equal(
    reviewCoverageCap({ census: { independent: 1, finalReview: null }, perTaskReview: 'always', tasks: 20 }),
    null,
  );
  assert.equal(
    reviewCoverageCap({ census: { independent: 5, finalReview: 'self' }, perTaskReview: 'per-group', tasks: 20 }),
    null,
  );
  // Witness: same knob/tasks, independent dropped back to 0 must cap. Proves
  // the nulls above came from independent > 0, not a no-op stub.
  assert.notEqual(
    reviewCoverageCap({ census: { independent: 0, finalReview: null }, perTaskReview: 'always', tasks: 20 }),
    null,
  );
});

test('reviewCoverageCap: a malformed census must not read as zero — the safe direction is not to cap', () => {
  // Missing/wrong-shaped `independent` must never be treated as 0: that would
  // cap a session on an absence, the failure direction this subsystem has
  // been reverted for twice (see the function's own comment).
  assert.equal(reviewCoverageCap({ census: undefined, perTaskReview: 'per-group', tasks: 10 }), null);
  assert.equal(reviewCoverageCap({ census: null, perTaskReview: 'per-group', tasks: 10 }), null);
  assert.equal(reviewCoverageCap({ census: {}, perTaskReview: 'per-group', tasks: 10 }), null, 'independent missing');
  assert.equal(
    reviewCoverageCap({ census: { independent: 'zero' }, perTaskReview: 'per-group', tasks: 10 }),
    null,
    'independent non-numeric',
  );
  assert.equal(
    reviewCoverageCap({ census: { independent: NaN }, perTaskReview: 'per-group', tasks: 10 }),
    null,
    'independent non-finite',
  );
  // Witness: same knob/tasks, a well-formed zero-independent census must cap.
  assert.notEqual(
    reviewCoverageCap({ census: { independent: 0, finalReview: null }, perTaskReview: 'per-group', tasks: 10 }),
    null,
  );
});

/**
 * Fix 1 (final-review-fixes, MAJOR) — wired through `scoreSession()`, not just
 * the pure `reviewCoverageCap` function above. `review.perTask` is an
 * INDEPENDENTLY OVERRIDABLE knob (preferences.mjs): `forge prefs -- --set
 * review.perTask=never` sets `.forge/preferences.local.json` regardless of
 * pace, and `shouldRunPerTaskReview` then correctly told the coordinator to
 * skip per-group reviewers. The first shipped version of this cap read
 * `session.resolvedPace` directly and had no way to see that override, so a
 * `standard`-pace session that obeyed `review.perTask=never` was still capped
 * 69/C, with a message asserting reviewers were prescribed — punishing the
 * exact obedience this cap exists to reward, the same failure class 0.3.24
 * shipped and 0.3.26 reverted, reached through the knob instead of the pace.
 * This is the independent final reviewer's exact repro.
 */
test('F13/review.perTask override: knob "never" at standard pace with zero reviews must not cap (reviewer\'s exact repro)', () => {
  const root = tmp('forge-score-cov-knob-never-');
  try {
    const { sessionDir, session } = makeReviewFixture(root, {
      slug: 'telemetry-dashboard-rollup',
      paceSignal: 'aggregate nightly dashboard telemetry counts',
      resolvedPace: 'standard',
      tasksTotal: 6,
      tasksComplete: 6,
    });
    fs.writeFileSync(
      path.join(root, '.forge', 'preferences.local.json'),
      `${JSON.stringify({ review: { perTask: 'never' } }, null, 2)}\n`,
      'utf8',
    );

    const card = scoreSession({ cwd: root, sessionDir, session });
    assert.deepEqual(
      card.caps,
      [],
      `review.perTask=never told the coordinator to skip per-group reviewers — obeying that must not be capped: ${capsJoin(card.caps)}`,
    );

    // Witness: removing the override (still standard pace, still zero
    // reviews) must cap — proves the empty caps array above came from the
    // knob override specifically, not from a fixture that never caps.
    fs.rmSync(path.join(root, '.forge', 'preferences.local.json'));
    const withoutOverride = scoreSession({ cwd: root, sessionDir, session });
    assert.equal(withoutOverride.caps.length, 1, capsJoin(withoutOverride.caps));
    assert.equal(withoutOverride.score, 69);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('F13/review.perTask override: knob "high-risk-only" overrides a thorough pace that would otherwise cap', () => {
  const root = tmp('forge-score-cov-knob-hro-');
  try {
    const { sessionDir, session } = makeReviewFixture(root, {
      slug: 'telemetry-dashboard-rollup',
      paceSignal: 'aggregate nightly dashboard telemetry counts',
      // thorough's preset knob is 'always', which would cap without the
      // override — proves this test exercises the KNOB overriding the pace,
      // not merely a pace that happens not to cap.
      resolvedPace: 'thorough',
      tasksTotal: 6,
      tasksComplete: 6,
    });
    fs.writeFileSync(
      path.join(root, '.forge', 'preferences.local.json'),
      `${JSON.stringify({ review: { perTask: 'high-risk-only' } }, null, 2)}\n`,
      'utf8',
    );

    const card = scoreSession({ cwd: root, sessionDir, session });
    assert.deepEqual(card.caps, [], capsJoin(card.caps));

    // Witness: same fixture without the override caps under the default
    // thorough->always mapping.
    fs.rmSync(path.join(root, '.forge', 'preferences.local.json'));
    const withoutOverride = scoreSession({ cwd: root, sessionDir, session });
    assert.equal(withoutOverride.caps.length, 1, capsJoin(withoutOverride.caps));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('F13/review.perTask resolution: an unreadable preferences file must not throw and must not cap (fail safe)', () => {
  const root = tmp('forge-score-cov-badprefs-');
  try {
    const { sessionDir, session } = makeReviewFixture(root, {
      slug: 'telemetry-dashboard-rollup',
      paceSignal: 'aggregate nightly dashboard telemetry counts',
      resolvedPace: 'standard',
      tasksTotal: 6,
      tasksComplete: 6,
    });
    // Malformed JSON: `loadJsonFile` (preferences.mjs) throws `JSON.parse`
    // errors on read. An absence is not a measurement — the same principle
    // the malformed-census guard above is built on — so this must not throw
    // and must not cap.
    fs.writeFileSync(path.join(root, '.forge', 'preferences.local.json'), '{ not valid json', 'utf8');

    assert.doesNotThrow(() => scoreSession({ cwd: root, sessionDir, session }));
    const card = scoreSession({ cwd: root, sessionDir, session });
    assert.deepEqual(
      card.caps,
      [],
      `an unreadable preferences file must fail safe (not cap): ${capsJoin(card.caps)}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review depth: a dispatched reviewer beats a self-check', () => {
  const root = tmp('forge-score-dispatched-');
  try {
    const { sessionDir, session, taskDir } = makeReviewFixture(root);
    fs.writeFileSync(
      path.join(taskDir, 'task-review.md'),
      '# Task review\n\nAPPROVED (pace self-check) — coordinator read the diff.\n',
      'utf8',
    );
    const selfOnly = reviewCheck(scoreSession({ cwd: root, sessionDir, session }));

    fs.writeFileSync(
      path.join(taskDir, 'group-review.md'),
      '# Group review\n\n**Verdict: APPROVED** (opus reviewer a3cbc561b60655bb8)\n',
      'utf8',
    );
    const dispatched = reviewCheck(scoreSession({ cwd: root, sessionDir, session }));

    assert.ok(
      dispatched.points > selfOnly.points,
      `dispatched (${dispatched.points}) should beat self-check-only (${selfOnly.points})`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review depth: a recorded rejection round scores as evidence the review had teeth', () => {
  // helm's group-6 REJECT→fix→APPROVE caught a flaky-green test about to
  // become 3-OS CI evidence. It is the most valuable artifact in the corpus
  // and used to score nothing.
  const root = tmp('forge-score-reject-');
  try {
    const { sessionDir, session, taskDir } = makeReviewFixture(root);
    fs.writeFileSync(
      path.join(taskDir, 'group-review.md'),
      '# Group 6 review\n\n**Verdict: APPROVED** (opus reviewer 9f2, after one fix round)\n\n## Round 1 — REJECTED\n\nOne blocker, four majors.\n',
      'utf8',
    );
    const withReject = reviewCheck(scoreSession({ cwd: root, sessionDir, session }));

    fs.writeFileSync(
      path.join(taskDir, 'group-review.md'),
      '# Group 6 review\n\n**Verdict: APPROVED** (opus reviewer 9f2)\n',
      'utf8',
    );
    const cleanApprove = reviewCheck(scoreSession({ cwd: root, sessionDir, session }));

    assert.ok(
      withReject.points > cleanApprove.points,
      `a rejection round (${withReject.points}) should outscore a first-pass approval (${cleanApprove.points})`,
    );
    assert.match(withReject.notes.join(' '), /reject/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review depth scores coverage, not presence — 1 review across 8 groups is thin', () => {
  const root = tmp('forge-score-coverage-');
  try {
    const { sessionDir, session } = makeReviewFixture(root);
    const tasksDir = path.join(sessionDir, 'tasks');
    for (const g of ['02-api', '03-mail', '04-client']) {
      fs.mkdirSync(path.join(tasksDir, g), { recursive: true });
      fs.writeFileSync(
        path.join(tasksDir, g, 'test-evidence.md'),
        '# Test evidence\n\n- **Exit code:** 0\n- **Summary:** asserts output\n',
        'utf8',
      );
    }
    fs.writeFileSync(
      path.join(tasksDir, '01-model', 'group-review.md'),
      '# Group review\n\n**Verdict: APPROVED** (opus reviewer 7c1)\n',
      'utf8',
    );
    const thin = reviewCheck(scoreSession({ cwd: root, sessionDir, session }));
    assert.match(thin.notes.join(' '), /thin coverage/);

    for (const g of ['02-api', '03-mail', '04-client']) {
      fs.writeFileSync(
        path.join(tasksDir, g, 'group-review.md'),
        '# Group review\n\n**Verdict: APPROVED** (opus reviewer 7c1)\n',
        'utf8',
      );
    }
    const full = reviewCheck(scoreSession({ cwd: root, sessionDir, session }));
    assert.ok(full.points > thin.points, `full coverage (${full.points}) should beat thin (${thin.points})`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Cap entry text — structured `{ text }` or legacy ledger strings.
 * F14 (score-coverage-denominator): caps are objects; keep probes readable.
 */
function capText(c) {
  return typeof c === 'string' ? c : (c?.text ?? '');
}
function capsJoin(caps) {
  return (caps ?? []).map(capText).join(' ');
}

/**
 * F14 — when the score is already ≤ OUTCOME_CAP, a high-risk condition is
 * recorded as a note (`applied: false`) rather than a real reduction. Fleet
 * must not treat that note as a process-failure cap (see fleet-report tests).
 */
test('F14: high-risk note when score already ≤ OUTCOME_CAP has applied:false and does not lower further', () => {
  const root = tmp('forge-score-f14-noted-');
  try {
    // incompleteReason lands at 59 — already under OUTCOME_CAP (69) — then
    // the high-risk floor would have capped at 69 if the score were higher.
    const { sessionDir, session } = makeReviewFixture(root, {
      slug: 'add-stripe-refund-auth',
      paceSignal: 'payment refunds behind an authorization gate',
      incompleteReason: 'E2E blocked',
    });
    const card = scoreSession({ cwd: root, sessionDir, session });

    assert.equal(card.score, 59, `incompleteReason must keep the score at 59, got ${card.score}`);
    const highRisk = card.caps.find((c) => (typeof c === 'object' ? c.id === 'high-risk' : /high-risk/i.test(capText(c))));
    assert.ok(highRisk, `expected a high-risk caps entry, got: ${capsJoin(card.caps)}`);
    assert.equal(typeof highRisk, 'object', 'F14: caps entries must be structured objects');
    assert.equal(highRisk.applied, false, 'score already ≤ OUTCOME_CAP — note only, do not mark applied');
    assert.match(capText(highRisk), /high-risk/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('F14: applied high-risk cap has applied:true, lowers score, and records before/after', () => {
  const root = tmp('forge-score-f14-applied-');
  try {
    const { sessionDir, session } = makeReviewFixture(root, {
      slug: 'add-stripe-refund-auth',
      paceSignal: 'payment refunds behind an authorization gate',
    });
    const card = scoreSession({ cwd: root, sessionDir, session });

    assert.equal(card.score, 69, `expected OUTCOME_CAP 69, got ${card.score}`);
    const highRisk = card.caps.find((c) => (typeof c === 'object' ? c.id === 'high-risk' : false));
    assert.ok(highRisk, `expected structured high-risk cap, got: ${capsJoin(card.caps)}`);
    assert.equal(highRisk.applied, true);
    assert.ok(typeof highRisk.before === 'number' && highRisk.before > 69, `before must exceed cap, got ${highRisk.before}`);
    assert.equal(highRisk.after, 69);
    assert.match(capText(highRisk), /independent final review|self-authored/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a high-risk session with no independent review is capped, however good its artifacts', () => {
  const root = tmp('forge-score-riskcap-');
  try {
    // Money/auth signal: the hard floor says an independent reviewer is
    // mandatory regardless of pace.
    const { sessionDir, session } = makeReviewFixture(root, {
      slug: 'add-stripe-refund-auth',
      paceSignal: 'payment refunds behind an authorization gate',
    });
    const card = scoreSession({ cwd: root, sessionDir, session });

    assert.ok(card.score <= 69, `expected a cap at C, got ${card.score}`);
    assert.match(capsJoin(card.caps), /independent final review/i);

    // Per-group reviews do NOT lift the cap: each saw one slice, and the floor
    // is an independent reader of the whole change.
    const taskDir = path.join(sessionDir, 'tasks', '01-model');
    fs.writeFileSync(
      path.join(taskDir, 'group-review.md'),
      '# Group review\n\n**Verdict: APPROVED** (opus reviewer 7c1)\n',
      'utf8',
    );
    assert.ok(scoreSession({ cwd: root, sessionDir, session }).score <= 69);

    // A self-authored final review is named as such, and still capped.
    fs.mkdirSync(path.join(sessionDir, 'reviews'), { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'reviews', 'final-review.md'),
      '# Final review\n\nReviewer: the coordinator — this is a self-review, dispatch was declined.\n',
      'utf8',
    );
    const selfFinal = scoreSession({ cwd: root, sessionDir, session });
    assert.ok(selfFinal.score <= 69);
    assert.match(capsJoin(selfFinal.caps), /self-authored/i);

    // An independent final review lifts it.
    fs.writeFileSync(
      path.join(sessionDir, 'reviews', 'final-review.md'),
      '# Final review\n\n**Verdict: APPROVED** — opus reviewer 4d2 read the whole diff.\n',
      'utf8',
    );
    const reviewed = scoreSession({ cwd: root, sessionDir, session });
    // Pin the actual caps array, not a substring probe: nothing should cap
    // this session at all — the money/auth floor lifts because the final
    // review is independent, and the separate F13 coverage floor does not
    // apply either, because the group-review.md written above (line ~484)
    // gives this session a genuine independent per-group reviewer
    // (census.independent > 0). A `/final review/i` probe would have gone
    // green by coincidence if F13's own cap text ever mentioned a final
    // review — it says nothing about *this* fixture's caps being empty.
    assert.deepEqual(reviewed.caps, [], capsJoin(reviewed.caps));
    assert.ok(reviewed.score > 69, `expected no cap, got ${reviewed.score}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the high-risk cap and the review points both follow the frozen verdict', () => {
  // The cap and the done gate must reach the same answer: a session refused at
  // the gate and then scored uncapped leaves the one record that outlives
  // cleanup silent about the missing review. `score.mjs` reads the census once
  // for review depth and again for the cap — both are pinned here.
  const root = tmp('forge-score-frozen-');
  try {
    const { sessionDir, session } = makeReviewFixture(root, {
      slug: 'add-stripe-refund-auth',
      paceSignal: 'payment refunds behind an authorization gate',
    });
    const reviewFile = path.join(sessionDir, 'reviews', 'final-review.md');
    fs.mkdirSync(path.dirname(reviewFile), { recursive: true });

    // Prose says the coordinator wrote it; the host recorded a dispatched
    // reviewer. Without the frozen verdict this session is capped — the control
    // that makes the assertion below mean something.
    fs.writeFileSync(reviewFile, '# Final review\n\nReviewer: the coordinator — a self-check.\n', 'utf8');
    const prose = scoreSession({ cwd: root, sessionDir, session });
    assert.ok(prose.score <= 69, `fixture: prose alone caps, got ${prose.score}`);

    const measured = scoreSession({
      cwd: root,
      sessionDir,
      session: {
        ...session,
        reviewVerdict: {
          final: 'independent',
          evidence: 'host',
          stoppedByOperator: false,
          // A session this product froze: `independent`/`host` is reachable
          // only from a bucket that exists (review-census.mjs's
          // `hostFinalReview` answers `self` whenever `units.final` is
          // absent), so the deciding unit was necessarily on record.
          unitOnRecord: true,
        },
      },
    });
    // The money/auth high-risk floor must be lifted — assert on its own
    // distinctive wording ("high-risk session"), not on any cap that merely
    // mentions "final review". This fixture has zero per-group reviews (no
    // group-review.md was ever written), so the separate F13 coverage floor
    // legitimately fires here and holds the score at 89/B; a generic
    // `/final review/i` probe would have matched F13's own cap text and
    // passed by coincidence while hiding that a cap still applies.
    assert.equal(
      measured.caps.some((c) => /high-risk session/i.test(capText(c))),
      false,
      capsJoin(measured.caps),
    );
    // Pin exactly which cap IS present, so a future change to either cap's
    // firing conditions shows up here instead of slipping past.
    assert.equal(measured.caps.length, 1, capsJoin(measured.caps));
    assert.match(capText(measured.caps[0]), /per-group reviewers/i);
    assert.ok(measured.score > prose.score, `expected the money/auth floor lifted, got ${measured.score}`);
    assert.equal(measured.score, 89, 'F13: zero per-group reviews + independent final review caps at 89/B');
    assert.match(reviewCheck(measured).notes.join(' '), /independent final review/);

    // And the other direction: prose names an outside reader, the host says no
    // final reviewer was dispatched. The cap must follow the measurement.
    fs.writeFileSync(reviewFile, '# Final review\n\n**Verdict: APPROVED** — opus reviewer 4d2.\n', 'utf8');
    const proseIndependent = scoreSession({ cwd: root, sessionDir, session });
    assert.ok(proseIndependent.score > 69, 'fixture: prose alone lifts the cap');

    const refuted = scoreSession({
      cwd: root,
      sessionDir,
      session: {
        ...session,
        reviewVerdict: {
          final: 'self',
          evidence: 'host',
          stoppedByOperator: false,
          // A session this product froze: `self`/`host`/`stoppedByOperator:
          // false` is only reachable through the undefined-bucket branch of
          // `hostFinalReview` (the stopped branch never answers `false` once
          // a bucket exists) — no `final` dispatch was ever on record.
          unitOnRecord: false,
        },
      },
    });
    assert.ok(refuted.score <= 69, `expected a cap at C, got ${refuted.score}`);
    assert.match(capsJoin(refuted.caps), /self-authored/i);
    assert.match(reviewCheck(refuted).notes.join(' '), /self-authored/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a frozen verdict read from prose is honoured too, not only a measured one', () => {
  // C1 in this group was a rule that treated the evidence grades asymmetrically
  // where they should have been equal. The scorer must not repeat it from the
  // other side: the freeze is the measurement taken at the transition whatever
  // grade it carries, and the cap has to agree with the gate — which honours an
  // `inferred` verdict without qualification, because on a host that writes no
  // sidecars that is the only verdict there will ever be.
  //
  // Discriminating fixture: a frozen `independent`/`inferred` sitting beside a
  // file whose prose reads as a self-check — the state a session is in when the
  // review file has moved on since the transition. Were the scorer to honour
  // only `host`, it would silently re-read the file and cap.
  const root = tmp('forge-score-frozen-inferred-');
  try {
    const { sessionDir, session } = makeReviewFixture(root, {
      slug: 'add-stripe-refund-auth',
      paceSignal: 'payment refunds behind an authorization gate',
    });
    const reviewFile = path.join(sessionDir, 'reviews', 'final-review.md');
    fs.mkdirSync(path.dirname(reviewFile), { recursive: true });
    fs.writeFileSync(reviewFile, '# Final review\n\nReviewer: the coordinator — a self-check.\n', 'utf8');

    const live = scoreSession({ cwd: root, sessionDir, session });
    assert.ok(live.score <= 69, `fixture: prose alone caps, got ${live.score}`);
    // Pin that it's specifically the money/auth high-risk floor doing the
    // capping here — not F13's coverage floor shadowing it at the same
    // threshold. This fixture has zero per-group reviews, so F13's own
    // tier-3 cap (69) would fire on this shape too; without this assertion,
    // disabling the high-risk cap entirely would leave `live.score <= 69`
    // still true (F13 alone produces the same number) and this test would
    // never notice the high-risk floor was gone.
    assert.match(capsJoin(live.caps), /high-risk session/i, capsJoin(live.caps));

    const frozen = scoreSession({
      cwd: root,
      sessionDir,
      session: {
        ...session,
        reviewVerdict: {
          final: 'independent',
          evidence: 'inferred',
          stoppedByOperator: false,
          // A session this product froze. `inferred` alone does not pin
          // `unitOnRecord` the way `host` does — it is reachable both with a
          // below-floor `final` dispatch on record and with no host bound at
          // all — so this fixture chooses the ordinary shape: no host was
          // ever bound at the freezing pass, so the deciding unit was never
          // on record and the prose alone decided.
          unitOnRecord: false,
        },
      },
    });
    // As above: assert the money/auth floor specifically ("high-risk
    // session") is gone, not a generic "final review" probe. This fixture
    // also has zero per-group reviews, so F13's own coverage floor legitimately
    // caps the score at 89/B — a `/final review/i` probe would have matched
    // that cap's text and hidden it.
    assert.equal(
      frozen.caps.some((c) => /high-risk session/i.test(capText(c))),
      false,
      capsJoin(frozen.caps),
    );
    assert.equal(frozen.caps.length, 1, capsJoin(frozen.caps));
    assert.match(capText(frozen.caps[0]), /per-group reviewers/i);
    assert.ok(frozen.score > live.score, `expected the money/auth floor lifted, got ${frozen.score}`);
    assert.equal(frozen.score, 89, 'F13: zero per-group reviews + independent final review caps at 89/B');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a frozen "there is no final review" keeps the cap on, whatever turned up afterwards', () => {
  // `{final: null, evidence: 'none'}` is the commonest frozen shape — 12 of the
  // 20 real sessions behind this change — and the one where treating an
  // explicit `null` verdict as a missing field is invisible: the cap would lift
  // itself off a review file dropped in after the measurement, on a high-risk
  // session, while the gate that read the same verdict had already refused.
  const root = tmp('forge-score-frozen-none-');
  try {
    const { sessionDir, session } = makeReviewFixture(root, {
      slug: 'add-stripe-refund-auth',
      paceSignal: 'payment refunds behind an authorization gate',
    });
    const reviewFile = path.join(sessionDir, 'reviews', 'final-review.md');
    fs.mkdirSync(path.dirname(reviewFile), { recursive: true });
    fs.writeFileSync(reviewFile, '# Final review\n\n**Verdict: APPROVED** — opus reviewer 4d2.\n', 'utf8');

    const prose = scoreSession({ cwd: root, sessionDir, session });
    assert.ok(prose.score > 69, `fixture: prose alone lifts the cap, got ${prose.score}`);

    const frozen = scoreSession({
      cwd: root,
      sessionDir,
      session: {
        ...session,
        // Deliberately three-field: a legacy session, frozen before
        // `unitOnRecord` existed. `{null, none}` does not discriminate which
        // host state produced it, so it stands in for the compatibility
        // population rather than a coherently-derived post-change one.
        reviewVerdict: { final: null, evidence: 'none', stoppedByOperator: false },
      },
    });
    assert.ok(frozen.score <= 69, `expected a cap at C, got ${frozen.score}`);
    assert.match(capsJoin(frozen.caps), /no independent final review/i);
    // The review-depth check reads the same verdict as the cap, so it must lose
    // the points the file would otherwise have earned. Compared against the
    // prose run rather than a quoted number: the difference is the measurement.
    assert.ok(
      reviewCheck(frozen).points < reviewCheck(prose).points,
      `depth followed the file instead of the verdict: ${reviewCheck(frozen).points} vs ${reviewCheck(prose).points}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A specs-engine change dir whose plan prose carries the risk, exactly as the
 * done gate reads it. The slug, paceSignal and spine stay deliberately bland.
 */
function makePlanFixture(root, planFiles, sessionOverrides = {}) {
  const { sessionDir, session, taskDir } = makeReviewFixture(root, {
    slug: 'telemetry',
    paceSignal: 'record token usage from host transcripts',
    planType: 'specs',
    openspecChange: 'my-change',
    ...sessionOverrides,
  });
  fs.writeFileSync(
    path.join(root, '.forge', 'config.json'),
    `${JSON.stringify({ plan: { engine: 'specs', dir: 'specs' } }, null, 2)}\n`,
    'utf8',
  );
  const changeDir = path.join(root, 'specs', 'changes', 'my-change');
  fs.mkdirSync(changeDir, { recursive: true });
  // A change-linked session is scored against the CHANGE dir's spine, not the
  // session's — without this the fixture scores 40 on a missing spine and the
  // cap has nothing left to cap.
  fs.writeFileSync(
    path.join(changeDir, 'spine.json'),
    `${JSON.stringify({ rows: [], notApplicable: 'sync reads only' }, null, 2)}\n`,
    'utf8',
  );
  for (const [name, body] of Object.entries(planFiles)) {
    fs.writeFileSync(path.join(changeDir, name), body, 'utf8');
  }
  return { sessionDir, session, taskDir, changeDir };
}

test('the scorer reads risk from the same plan text the done gate does', () => {
  // The gate (set-phase → collectPlanFacts) reads proposal/design/tasks/specs;
  // the scorer used to build its own riskText from slug + paceSignal + change +
  // spine only. A change whose risk is stated in its plan prose — the ordinary
  // case — blocked at `forge phase done` and then scored an uncapped A, so the
  // one record that survives cleanup said nothing about the missing review.
  // Shipped that way in 0.3.22; this is the regression test.
  const root = tmp('forge-score-gate-parity-');
  try {
    const { sessionDir, session, changeDir } = makePlanFixture(root, {
      'proposal.md': '# Proposal\n\nAdds an auth token exchange for the payments webhook.\n',
      'tasks.md': '# Tasks\n\n- [x] 1.1 wire it\n',
    });

    const facts = collectPlanFacts({ cwd: root, session });
    assert.equal(facts.highRisk, true, 'precondition: the gate sees the risk');
    assert.equal(facts.changeDir, changeDir);

    const card = scoreSession({ cwd: root, sessionDir, session });
    assert.ok(card.score <= 69, `the gate blocked this change; the scorer gave it ${card.score}`);
    assert.match(capsJoin(card.caps), /independent final review/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a plan that says nothing risky is still not capped', () => {
  // The union must not turn every session into a high-risk one: scanning more
  // text is only safe if bland text stays bland.
  const root = tmp('forge-score-gate-parity-bland-');
  try {
    const { sessionDir, session } = makePlanFixture(root, {
      'proposal.md': '# Proposal\n\nHarvest token counts from the host transcript and total them.\n',
      'tasks.md': '# Tasks\n\n- [x] 1.1 read the jsonl\n',
    });

    assert.equal(collectPlanFacts({ cwd: root, session }).highRisk, false);
    const bland = scoreSession({ cwd: root, sessionDir, session });
    // Pin the actual caps array, not a substring probe: nothing should cap
    // this session — not the money/auth floor (not high-risk) and not F13's
    // coverage floor either, because this fixture's tasks.md carries only one
    // checkbox (planFacts.tasks === 1 < 5, F13's own task-count gate). A
    // `/final review/i` probe would have passed by coincidence even if some
    // cap fired and happened to say "final review" — it says nothing about
    // whether this session is actually uncapped.
    assert.deepEqual(bland.caps, [], `unexpected cap: ${capsJoin(bland.caps)}`);

    // Same fixture, one risky sentence added: the cap appears and the score
    // drops. Comparing the two is what shows the union discriminates rather
    // than simply capping everything it can now read.
    fs.writeFileSync(
      path.join(root, 'specs', 'changes', 'my-change', 'proposal.md'),
      '# Proposal\n\nHarvest token counts, and add an auth token exchange for payments.\n',
      'utf8',
    );
    const risky = scoreSession({ cwd: root, sessionDir, session });
    assert.match(capsJoin(risky.caps), /independent final review/i);
    assert.ok(
      bland.score > risky.score,
      `bland ${bland.score} should outscore risky-with-no-reviewer ${risky.score}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unreadable plan does not make the scorer less sensitive than it was', () => {
  // Fail closed: with no change dir at all, the old slug/paceSignal/spine read
  // is still the answer, not a silently lowered bar.
  const root = tmp('forge-score-gate-parity-noplan-');
  try {
    const { sessionDir, session } = makeReviewFixture(root, {
      slug: 'add-stripe-refund-auth',
      paceSignal: 'payment refunds behind an authorization gate',
      openspecChange: null,
    });
    assert.equal(collectPlanFacts({ cwd: root, session }).readable, false);

    const card = scoreSession({ cwd: root, sessionDir, session });
    assert.ok(card.score <= 69, `expected the slug-based cap to still fire, got ${card.score}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * F13 regression: `collectPlanFacts` sets `readable: true` when EITHER
 * tasks.md OR proposal.md has content, but only ever counts `tasks` from
 * tasks.md checkbox lines. A change dir with a proposal and no tasks.md is
 * therefore `readable: true, tasks: 0` — and the F13 call site read that 0 as
 * a measurement, which defeated its own `tasks >= 5` guard and silently
 * disabled the whole cap on any such session (a thorough-pace session with
 * zero review artifacts scored 95, caps: [], against unmodified code). This
 * is 0.3.25's defect moved one field over: a value one code path leaves at
 * zero, read by a guard as though it had been measured.
 */
test('F13: a plan with a proposal but no tasks.md must not exempt the session from the coverage cap', () => {
  const root = tmp('forge-score-f13-planfacts-zero-');
  try {
    const { sessionDir, session } = makePlanFixture(
      root,
      {
        'proposal.md': '# Proposal\n\nHarvest token counts from the host transcript and total them.\n',
        // Deliberately no tasks.md: the shape that produced readable:true,
        // tasks:0.
      },
      { resolvedPace: 'thorough' },
    );

    const facts = collectPlanFacts({ cwd: root, session });
    assert.equal(facts.readable, true, 'precondition: a proposal alone makes the plan "readable"');
    assert.equal(facts.tasks, 0, 'precondition: no tasks.md means zero counted tasks, not zero measured tasks');
    assert.equal(facts.highRisk, false, 'precondition: bland proposal — must not be the money/auth floor doing the work');

    const card = scoreSession({ cwd: root, sessionDir, session });
    assert.ok(card.score <= 69, `expected F13 to still cap at 69, got ${card.score}`);
    assert.match(capsJoin(card.caps), /per-group reviewers/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * F13's lift, exemptions and softened tier, through `scoreSession()` — the
 * wired path. Direct unit tests for `reviewCoverageCap` already prove the six
 * rules in isolation (above); these prove the rules are actually *reached*
 * with the right inputs when scoring a real session directory, per the task
 * 03 brief (specs/changes/review-coverage-cap).
 *
 * Every fixture below stays deliberately bland (slug `telemetry-dashboard-rollup`,
 * paceSignal about dashboard telemetry) so the pre-existing money/auth
 * high-risk floor (`isHighRiskText` / `THOROUGH_RE`) never fires alongside
 * F13 — `makeReviewFixture`'s default slug `add-billing` trips that floor,
 * and building on it here would let a "not capped" assertion pass for the
 * wrong reason, or a "capped" assertion prove nothing about F13 specifically.
 * Every assertion below therefore checks the `caps` array's *contents*, or an
 * exact score, rather than an inequality a different cap could also satisfy.
 */

/** Grade bands, worst to best, so a comparison survives re-tuning either grade cutoff. */
const GRADE_ORDER = ['F', 'D', 'C', 'B', 'A'];
function gradeRank(g) {
  const i = GRADE_ORDER.indexOf(g);
  assert.notEqual(i, -1, `unknown grade ${g}`);
  return i;
}

/** The 89-tier shape: zero per-group reviews, an independent final review, on disk (no frozen verdict involved). */
function make89TierFixture(root, overrides = {}) {
  const { sessionDir, session } = makeReviewFixture(root, {
    slug: 'telemetry-dashboard-rollup',
    paceSignal: 'aggregate nightly dashboard telemetry counts',
    resolvedPace: 'standard',
    tasksTotal: 6,
    tasksComplete: 6,
    ...overrides,
  });
  fs.mkdirSync(path.join(sessionDir, 'reviews'), { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'reviews', 'final-review.md'),
    '# Final review\n\n**Verdict: APPROVED** — opus reviewer 4d2 read the whole diff.\n',
    'utf8',
  );
  return { sessionDir, session };
}

test('3.1 review-coverage cap (F13): one independent per-group review lifts the cap and beats the 89 tier', () => {
  const roots = [];
  try {
    const rootLift = tmp('forge-score-cov-lift-');
    roots.push(rootLift);
    const lift = makeReviewFixture(rootLift, {
      slug: 'telemetry-dashboard-rollup',
      paceSignal: 'aggregate nightly dashboard telemetry counts',
      resolvedPace: 'thorough',
      tasksTotal: 6,
      tasksComplete: 6,
    });
    fs.writeFileSync(
      path.join(lift.taskDir, 'group-review.md'),
      '# Group review\n\n**Verdict: APPROVED** (opus reviewer 7c1)\n',
      'utf8',
    );
    const liftCard = scoreSession({ cwd: rootLift, sessionDir: lift.sessionDir, session: lift.session });

    // Assert the caps array directly (not a substring probe) — this file's
    // deliberate style — so a newly introduced cap of any kind is visible
    // here instead of slipping past.
    assert.deepEqual(liftCard.caps, [], capsJoin(liftCard.caps));
    assert.ok(liftCard.score > 89, `expected the lift to clear the 89 tier, got ${liftCard.score}`);

    // Witness: the identical fixture minus the group review caps at 69 —
    // proves the empty caps array above came from the review lifting the
    // cap specifically, not from a fixture that would never cap regardless.
    const rootZero = tmp('forge-score-cov-lift-zero-');
    roots.push(rootZero);
    const zero = makeReviewFixture(rootZero, {
      slug: 'telemetry-dashboard-rollup',
      paceSignal: 'aggregate nightly dashboard telemetry counts',
      resolvedPace: 'thorough',
      tasksTotal: 6,
      tasksComplete: 6,
    });
    const zeroCard = scoreSession({ cwd: rootZero, sessionDir: zero.sessionDir, session: zero.session });
    assert.equal(zeroCard.caps.length, 1, capsJoin(zeroCard.caps));
    assert.equal(zeroCard.score, 69);

    // 3.4: the lift must land in a grade strictly better than the 89 tier's —
    // not merely a higher number in the same band. Compared against the
    // actual computed 89-tier grade (never a hardcoded 'B') so the pin
    // survives future re-tuning of either threshold.
    const root89 = tmp('forge-score-cov-lift-89-');
    roots.push(root89);
    const tier89 = make89TierFixture(root89);
    const card89 = scoreSession({ cwd: root89, sessionDir: tier89.sessionDir, session: tier89.session });
    assert.equal(card89.score, 89);
    assert.ok(
      gradeRank(liftCard.grade) > gradeRank(card89.grade),
      `expected the lift (${liftCard.grade}) to strictly beat the 89 tier (${card89.grade})`,
    );
  } finally {
    roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true }));
  }
});

test('3.2 review-coverage cap (F13): brisk pace with zero reviews is exempt — obeying the pace must not be punished', () => {
  const root = tmp('forge-score-cov-brisk-');
  try {
    const { sessionDir, session } = makeReviewFixture(root, {
      slug: 'telemetry-dashboard-rollup',
      paceSignal: 'aggregate nightly dashboard telemetry counts',
      resolvedPace: 'brisk',
      tasksTotal: 6,
      tasksComplete: 6,
    });
    const card = scoreSession({ cwd: root, sessionDir, session });
    assert.deepEqual(card.caps, [], capsJoin(card.caps));

    // Witness: the identical fixture at 'standard' pace (still zero reviews)
    // must cap — proves the empty caps array above came from the brisk
    // exemption specifically, not from a fixture that would never cap
    // regardless of pace.
    const standardTwin = scoreSession({ cwd: root, sessionDir, session: { ...session, resolvedPace: 'standard' } });
    assert.equal(standardTwin.caps.length, 1, capsJoin(standardTwin.caps));
    assert.equal(standardTwin.score, 69);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('3.2 review-coverage cap (F13): lite pace with zero reviews is exempt — obeying the pace must not be punished', () => {
  const root = tmp('forge-score-cov-lite-');
  try {
    const { sessionDir, session } = makeReviewFixture(root, {
      slug: 'telemetry-dashboard-rollup',
      paceSignal: 'aggregate nightly dashboard telemetry counts',
      resolvedPace: 'lite',
      tasksTotal: 6,
      tasksComplete: 6,
    });
    const card = scoreSession({ cwd: root, sessionDir, session });
    assert.deepEqual(card.caps, [], capsJoin(card.caps));

    // Witness: same fixture at 'standard' pace must cap.
    const standardTwin = scoreSession({ cwd: root, sessionDir, session: { ...session, resolvedPace: 'standard' } });
    assert.equal(standardTwin.caps.length, 1, capsJoin(standardTwin.caps));
    assert.equal(standardTwin.score, 69);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('3.2 review-coverage cap (F13): a plan-derived task count under the floor is exempt at standard pace with zero reviews', () => {
  const root = tmp('forge-score-cov-floor-plan-');
  try {
    const { sessionDir, session, changeDir } = makePlanFixture(
      root,
      {
        'proposal.md': '# Proposal\n\nHarvest token counts from the host transcript and total them.\n',
        'tasks.md': '# Tasks\n\n- [x] 1.1 read the jsonl\n- [x] 1.2 total it\n- [x] 1.3 write the digest\n',
      },
      { resolvedPace: 'standard' },
    );
    const facts = collectPlanFacts({ cwd: root, session });
    assert.equal(facts.readable, true, 'precondition: the plan is readable');
    assert.equal(facts.highRisk, false, 'precondition: bland plan — must not be the money/auth floor doing the work');
    assert.equal(facts.tasks, 3, 'precondition: fewer than the 5-task floor, measured from the plan');

    const card = scoreSession({ cwd: root, sessionDir, session });
    assert.deepEqual(card.caps, [], capsJoin(card.caps));

    // Witness: two more tasks.md checkboxes cross the 5-task floor and the
    // identical (still zero-review) session caps — proves the empty caps
    // array above came from the task-count guard reading the plan-derived
    // count specifically, not from a fixture that would never cap regardless.
    fs.appendFileSync(path.join(changeDir, 'tasks.md'), '- [x] 1.4 ship it\n- [x] 1.5 verify it\n');
    assert.equal(collectPlanFacts({ cwd: root, session }).tasks, 5);
    const overFloor = scoreSession({ cwd: root, sessionDir, session });
    assert.equal(overFloor.caps.length, 1, capsJoin(overFloor.caps));
    assert.equal(overFloor.score, 69);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('3.2 review-coverage cap (F13): a below-floor tasksTotal is exempt too, when the plan is unreadable', () => {
  const root = tmp('forge-score-cov-floor-total-');
  try {
    const { sessionDir, session } = makeReviewFixture(root, {
      slug: 'telemetry-dashboard-rollup',
      paceSignal: 'aggregate nightly dashboard telemetry counts',
      resolvedPace: 'standard',
      tasksTotal: 3,
      tasksComplete: 3,
      openspecChange: null,
    });
    assert.equal(collectPlanFacts({ cwd: root, session }).readable, false, 'precondition: no plan to read');

    const card = scoreSession({ cwd: root, sessionDir, session });
    assert.deepEqual(card.caps, [], capsJoin(card.caps));

    // Witness: bumping session.tasksTotal to 5 (still zero reviews, still no
    // plan) crosses the floor via the tasksTotal fallback specifically and
    // must cap.
    const overFloor = scoreSession({ cwd: root, sessionDir, session: { ...session, tasksTotal: 5 } });
    assert.equal(overFloor.caps.length, 1, capsJoin(overFloor.caps));
    assert.equal(overFloor.score, 69);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('3.3/3.4 review-coverage cap (F13): the 89 tier follows the frozen verdict, not self-authored prose, and grades a B', () => {
  // The discriminating fixture the brief calls for: prose alone reads as
  // self-authored, but the frozen verdict (the same shape `set-phase.mjs`
  // freezes at the done-gate transition, and the same value the gate itself
  // read) says independent. The cap must follow the verdict, because that
  // verdict is the one record that outlives session cleanup.
  const root = tmp('forge-score-cov-frozen89-');
  try {
    const { sessionDir, session } = makeReviewFixture(root, {
      slug: 'telemetry-dashboard-rollup',
      paceSignal: 'aggregate nightly dashboard telemetry counts',
      resolvedPace: 'standard',
      tasksTotal: 6,
      tasksComplete: 6,
    });
    const reviewFile = path.join(sessionDir, 'reviews', 'final-review.md');
    fs.mkdirSync(path.dirname(reviewFile), { recursive: true });
    fs.writeFileSync(reviewFile, '# Final review\n\nReviewer: the coordinator — a self-check.\n', 'utf8');

    // Control: no frozen verdict — prose decides, harsh (69) tier, grade C.
    const prose = scoreSession({ cwd: root, sessionDir, session });
    assert.equal(prose.caps.length, 1, capsJoin(prose.caps));
    assert.equal(prose.score, 69, 'fixture control: prose alone caps at the harsh tier');
    assert.equal(prose.grade, 'C', '3.4: the 69 tier must land in grade C');

    // A frozen verdict of `independent` overrides the prose.
    const measured = scoreSession({
      cwd: root,
      sessionDir,
      session: {
        ...session,
        reviewVerdict: {
          final: 'independent',
          evidence: 'host',
          stoppedByOperator: false,
          unitOnRecord: true,
        },
      },
    });
    assert.equal(measured.caps.length, 1, capsJoin(measured.caps));
    assert.equal(measured.score, 89, 'F13: the frozen verdict, not the self-authored prose, must decide the tier');
    assert.equal(measured.grade, 'B', "3.4: the 89 tier must land in grade B — the whole point of softening it");

    // 3.4: the two tiers must land in different bands, asserted as a
    // relationship (not just the two literals), so the pin survives
    // re-tuning of either threshold.
    assert.notEqual(gradeRank(prose.grade), gradeRank(measured.grade));
    assert.ok(gradeRank(measured.grade) > gradeRank(prose.grade));
    assert.equal(gradeForScore(measured.score), measured.grade);
    assert.equal(gradeForScore(prose.score), prose.grade);

    // The two cap texts must be distinguishable from each other — matched on
    // a fragment, not the exact string, so a future rewording for clarity
    // does not break this pin for no reason.
    assert.notEqual(capText(prose.caps[0]), capText(measured.caps[0]));
    assert.match(capText(prose.caps[0]), /per-group reviewers were dispatched/i);
    assert.match(capText(measured.caps[0]), /per-group reviewers were dispatched/i);
    assert.match(capText(measured.caps[0]), /softened to a B/i);
    assert.doesNotMatch(capText(prose.caps[0]), /softened to a B/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Fix 2 (final-review-fixes, MEDIUM) — the call site reads
 * `if (coverageCap && score > coverageCap.cap)`. A CAP IS A CEILING, NEVER A
 * FLOOR: deleting `&& score > coverageCap.cap` left all 872 tests plus the
 * e2e green, while a session already capped to 59/D by `incompleteReason`
 * was unconditionally overwritten to 89/B by the (higher) review-coverage
 * ceiling — the most damaging thing a "cap" in this file could do, since it
 * would launder an incomplete/unreviewed session into a passing grade. This
 * fixture combines both caps deliberately: `make89TierFixture` alone earns
 * the 89 tier (proven by the 3.3/3.4 test above), and adding
 * `incompleteReason` here makes the OTHER cap fire first and land lower —
 * so if the guard is missing, the review-coverage cap's unconditional
 * overwrite is the only way this test could see anything but 59.
 */
test('review-coverage cap: a cap already applied by incompleteReason must not be overwritten upward (F13 fix 2)', () => {
  const root = tmp('forge-score-cov-never-raises-');
  try {
    const { sessionDir, session } = make89TierFixture(root, {
      incompleteReason: 'E2E blocked',
    });
    const card = scoreSession({ cwd: root, sessionDir, session });

    assert.equal(card.score, 59, `incompleteReason's lower cap must survive, got ${card.score}`);
    assert.equal(card.grade, 'D');
    assert.equal(
      card.caps.filter((c) => /incompleteReason/.test(capText(c))).length,
      1,
      capsJoin(card.caps),
    );
    // The review-coverage cap must not add its own entry here: it never
    // fired, because the score was already at or below its ceiling. A cap
    // entry claiming to have "reduced" a score it actually raised is exactly
    // the defect this test exists to catch.
    assert.equal(
      card.caps.some((c) => /per-group reviewers were dispatched/i.test(capText(c))),
      false,
      `the review-coverage cap must not appear when it would only raise the score: ${capsJoin(card.caps)}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('invariant: applying the review-coverage cap never increases the score, across several F13 fixtures', () => {
  // Belt-and-suspenders for the fix above (brief: "consider also pinning the
  // general invariant"). Replays several review-coverage-cap scenarios
  // already established in this file and, wherever the cap actually fired
  // (a caps[] entry naming it, which always records "(was N)"), asserts the
  // resulting score never exceeds the pre-cap N — the shape any future
  // variant of the missing-guard defect would also have to violate.
  const roots = [];
  try {
    const cards = [];

    const r1 = tmp('forge-score-cov-inv-fires-');
    roots.push(r1);
    const f1 = makeReviewFixture(r1, {
      slug: 'telemetry-dashboard-rollup',
      paceSignal: 'aggregate nightly dashboard telemetry counts',
      resolvedPace: 'thorough',
      tasksTotal: 6,
      tasksComplete: 6,
    });
    cards.push(scoreSession({ cwd: r1, sessionDir: f1.sessionDir, session: f1.session }));

    const r2 = tmp('forge-score-cov-inv-89-');
    roots.push(r2);
    const f2 = make89TierFixture(r2);
    cards.push(scoreSession({ cwd: r2, sessionDir: f2.sessionDir, session: f2.session }));

    const r3 = tmp('forge-score-cov-inv-incomplete-');
    roots.push(r3);
    const f3 = make89TierFixture(r3, { incompleteReason: 'E2E blocked' });
    cards.push(scoreSession({ cwd: r3, sessionDir: f3.sessionDir, session: f3.session }));

    let sawAFire = false;
    for (const card of cards) {
      const capEntry = card.caps.find((c) => /per-group reviewers were dispatched/i.test(capText(c)));
      if (!capEntry) continue; // this scenario's coverage cap did not fire
      sawAFire = true;
      const m = capText(capEntry).match(/\(was (\d+)\)/);
      assert.ok(m, `a firing cap entry must record its pre-cap score: ${capEntry}`);
      const before = Number(m[1]);
      assert.ok(card.score <= before, `coverage cap must never raise the score: ${before} -> ${card.score}`);
    }
    assert.ok(sawAFire, 'fixture setup problem: none of these scenarios exercised the coverage cap at all');
  } finally {
    roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true }));
  }
});

/**
 * A session whose plan has `groups` tasks.md sections, `batches` implementer
 * task dirs (each with tier-2 evidence), and one review file per entry in
 * `reviews` — `'independent'` names an outside reviewer, `'self'` declares a
 * self-check. Group reviews live in `group-NN-*` dirs, as the skill instructs.
 */
function makeCoverageFixture(root, { groups, batches, reviews, final = null, session: over = {} }) {
  const { sessionDir, session } = makeSession(root, {
    slug: 'telemetry',
    planType: 'specs',
    openspecChange: 'my-change',
    tasksTotal: 20,
    tasksComplete: 20,
    resolvedPace: 'standard',
    ...over,
  });
  fs.writeFileSync(
    path.join(root, '.forge', 'config.json'),
    `${JSON.stringify({ plan: { engine: 'specs', dir: 'specs' } }, null, 2)}\n`,
    'utf8',
  );
  const changeDir = path.join(root, 'specs', 'changes', 'my-change');
  fs.mkdirSync(changeDir, { recursive: true });
  fs.writeFileSync(
    path.join(changeDir, 'spine.json'),
    `${JSON.stringify({ rows: [], notApplicable: 'sync reads only' }, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(changeDir, 'proposal.md'), '# Proposal\n\nHarvest counts.\n', 'utf8');
  fs.writeFileSync(
    path.join(changeDir, 'tasks.md'),
    `# Tasks\n\n${Array.from({ length: groups }, (_, i) => `## ${i + 1}. Group ${i + 1}\n\n- [x] ${i + 1}.1 do it\n`).join('\n')}`,
    'utf8',
  );
  fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# Verify\n\nExit 0\n', 'utf8');

  for (let i = 0; i < batches; i += 1) {
    const d = path.join(sessionDir, 'tasks', `0${i + 1}-batch`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(d, 'test-evidence.md'),
      '# Test evidence\n\n- **Exit code:** 0\n- **Summary:** asserts the row is written\n',
      'utf8',
    );
  }
  reviews.forEach((kind, i) => {
    // Deliberately NOT named `group-*`: the exclusion is supposed to key on
    // content, and a fixture that names its review dirs by convention lets a
    // purely name-based implementation pass. The reviewer proved the old
    // fixture did exactly that.
    const d = path.join(sessionDir, 'tasks', `${i + 1}-reviewed-section`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(d, 'group-review.md'),
      kind === 'independent'
        ? `Reviewer: claude-opus-5 (task-reviewer)\n\n**Verdict: APPROVED**\n`
        : `APPROVED (pace self-check) — coordinator wrote this one\n`,
      'utf8',
    );
  });
  if (final) {
    fs.mkdirSync(path.join(sessionDir, 'reviews'), { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'reviews', 'final-review.md'),
      final === 'independent'
        ? 'Reviewer: claude-opus-5 (final-reviewer)\n\n**READY**\n'
        : 'Reviewer: coordinator — self-review\n\n**READY**\n',
      'utf8',
    );
  }
  return { sessionDir, session };
}

function check(card, id) {
  return card.checks.find((c) => c.id === id);
}

test('a group-review folder is a review, not a unit of work needing one', () => {
  // `tasks/` holds both implementer batches and the `group-NN-*` dirs the
  // reviews live in. Counting the latter as task dirs punished a session twice
  // for doing group reviews: the evidence ratio fell (review folders carry no
  // test-evidence.md) and review coverage was measured against an inflated
  // denominator. Observed live as "tier-2 evidence in 9/12 task dirs" on a
  // session where all 9 batches had evidence.
  const root = tmp('forge-score-units-');
  try {
    const { sessionDir, session } = makeCoverageFixture(root, {
      groups: 3,
      batches: 4,
      reviews: ['independent', 'independent', 'independent'],
      final: 'independent',
    });
    const card = scoreSession({ cwd: root, sessionDir, session });

    assert.match(
      check(card, 'tasks').notes.join(' '),
      /evidence in 4\/4/,
      'all four batches carry evidence; the review folders are not batches',
    );
    assert.match(
      check(card, 'reviews').notes.join(' '),
      /3 dispatched review\(s\) across 3 task group\(s\)/,
      'coverage is measured against tasks.md groups — the unit a group review covers',
    );
    // 2 for full group coverage + 2 for an independent final review; the
    // remaining point is only earned by a round that rejected work.
    assert.equal(check(card, 'reviews').points, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a plan with no section headings is one group, not one per batch', () => {
  // pace.md: "If tasks.md has no section headings, treat the whole file as one
  // group (review once when all tasks are done)." Falling through to the batch
  // count reported "1 of 6 task groups reviewed" for the shape the skill
  // recommends. An independent review found this change had no test at all —
  // restoring the previous expression passed the whole suite.
  const root = tmp('forge-score-headingless-');
  try {
    const f = makeCoverageFixture(root, { groups: 0, batches: 6, reviews: ['independent'] });
    fs.writeFileSync(
      path.join(root, 'specs', 'changes', 'my-change', 'tasks.md'),
      '# Tasks\n\n- [x] 1.1 a\n- [x] 1.2 b\n',
      'utf8',
    );
    const notes = reviewCheck(scoreSession({ cwd: root, sessionDir: f.sessionDir, session: f.session })).notes;
    assert.match(notes.join(' '), /across 1 task group\(s\)/);
    assert.doesNotMatch(notes.join(' '), /thin coverage/, 'one review of one group is full coverage');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the 0.5 coverage boundary is worth a point, in both directions', () => {
  // Deleted along with the coverage cap; an independent review showed the
  // threshold still decides 2 points vs 1 and nothing pinned it any more.
  const root = tmp('forge-score-boundary-');
  try {
    const half = makeCoverageFixture(root, {
      groups: 4,
      batches: 4,
      reviews: ['independent', 'independent', 'self'],
    });
    const at = reviewCheck(scoreSession({ cwd: root, sessionDir: half.sessionDir, session: half.session }));
    assert.match(at.notes.join(' '), /2 dispatched review\(s\) across 4 task group\(s\)(?!.*thin)/);

    const root2 = tmp('forge-score-boundary-under-');
    const under = makeCoverageFixture(root2, {
      groups: 4,
      batches: 4,
      reviews: ['independent', 'self', 'self'],
    });
    const below = reviewCheck(scoreSession({ cwd: root2, sessionDir: under.sessionDir, session: under.session }));
    assert.match(below.notes.join(' '), /thin coverage/);
    assert.ok(at.points > below.points, `at-threshold ${at.points} should beat below ${below.points}`);
    fs.rmSync(root2, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an independent final review outscores a self-authored one', () => {
  // Also unpinned by the revert: nothing asserted the self-vs-independent gap
  // on the final review, so scoring them identically passed the suite.
  const roots = [];
  try {
    const score = (final) => {
      const root = tmp('forge-score-finalgap-');
      roots.push(root);
      const f = makeCoverageFixture(root, { groups: 3, batches: 3, reviews: ['independent'], final });
      return reviewCheck(scoreSession({ cwd: root, sessionDir: f.sessionDir, session: f.session })).points;
    };
    assert.ok(score('independent') > score('self'), 'an outside reader of the whole change is worth more');
  } finally {
    roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true }));
  }
});

test('a red e2e run caps the score — artifacts cannot outvote a failing product loop', () => {
  const root = tmp('forge-score-redcap-');
  try {
    const { sessionDir, session } = makeSession(root, {
      slug: 'phase-1',
      openspecChange: 'phase-1',
      planType: 'specs',
    });
    const changeDir = path.join(root, 'specs', 'changes', 'phase-1');
    fs.mkdirSync(changeDir, { recursive: true });
    const steps = [{ name: 'bench-gate', cmd: 'true' }];
    fs.writeFileSync(
      path.join(changeDir, 'spine.json'),
      `${JSON.stringify({ rows: [], notApplicable: 'sync only' }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(changeDir, 'e2e.json'), `${JSON.stringify({ steps })}\n`, 'utf8');
    fs.writeFileSync(
      path.join(sessionDir, 'e2e-results.json'),
      `${JSON.stringify({
        ok: false,
        ranAt: new Date().toISOString(),
        stepsHash: e2eStepsHash(steps),
        steps: [{ name: 'bench-gate', ok: false, exitCode: 1 }],
      })}\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# Verify\n\n## Product loop\n\n1. run it\n', 'utf8');

    const card = scoreSession({ cwd: root, sessionDir, session });
    assert.ok(card.score <= 69, `expected a cap at C, got ${card.score}`);
    assert.match(capsJoin(card.caps), /e2e|product loop/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scoreSession: missing spine scores poorly', () => {
  const root = tmp('forge-score-weak-');
  try {
    const { sessionDir, session } = makeSession(root);
    fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# ok\n', 'utf8');
    const card = scoreSession({ cwd: root, sessionDir, session });
    assert.ok(card.score < 60, `expected weak score, got ${card.score}`);
    assert.equal(card.integrityOk, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scoreSession: incompleteReason caps score at 59', () => {
  const root = tmp('forge-score-cap-');
  try {
    const { sessionDir, session } = makeSession(root, {
      incompleteReason: 'E2E blocked',
      slug: 'add-health',
    });
    fs.writeFileSync(
      path.join(sessionDir, 'spine.json'),
      `${JSON.stringify({ rows: [], notApplicable: 'sync HTTP only' }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# ok\n', 'utf8');
    const card = scoreSession({ cwd: root, sessionDir, session });
    assert.ok(card.score <= 59);
    assert.ok(card.caps.some((c) => /incompleteReason/.test(capText(c))));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scoreSession: product-loop with baseline-diff scores higher than bare section', () => {
  const root = tmp('forge-score-loop-');
  try {
    const { sessionDir, session } = makeSession(root, { slug: 'wire-worker-jobs' });
    fs.writeFileSync(
      path.join(sessionDir, 'spine.json'),
      `${JSON.stringify(validSpine([validRow()]), null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(sessionDir, 'verify-evidence.md'),
      '# Verify\n\n## Product loop\n\nJust a heading\n',
      'utf8',
    );
    const weak = scoreSession({ cwd: root, sessionDir, session });

    fs.writeFileSync(
      path.join(sessionDir, 'verify-evidence.md'),
      `# Verify

## Product loop

Fixture: OP1086

1. ingest
2. analyze
3. ratify
4. run @R — output differs from baseline
`,
      'utf8',
    );
    const strong = scoreSession({ cwd: root, sessionDir, session });
    assert.ok(strong.score > weak.score, `${strong.score} should beat ${weak.score}`);
    const loop = strong.checks.find((c) => c.id === 'product_loop');
    assert.ok(loop.points >= 15);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scoreSession: product-loop bonuses match inflected forms (asserts, fixtures, ratify)', () => {
  const root = tmp('forge-score-inflect-');
  try {
    const { sessionDir, session } = makeSession(root, { slug: 'jobs-loop' });
    fs.writeFileSync(
      path.join(sessionDir, 'spine.json'),
      `${JSON.stringify(validSpine([validRow()]), null, 2)}\n`,
      'utf8',
    );
    // Every keyword deliberately inflected — a trailing \b used to reject all of these.
    fs.writeFileSync(
      path.join(sessionDir, 'verify-evidence.md'),
      '# Verify\n\n## Product loop\n\n1. seed fixtures\n2. run the loop\n3. asserts the ratify output differs from stored baselines\n',
      'utf8',
    );
    const card = scoreSession({ cwd: root, sessionDir, session });
    const loop = card.checks.find((c) => c.id === 'product_loop');
    const notes = loop.notes.join('\n');
    assert.match(notes, /names a fixture/);
    assert.match(notes, /asserts decision\/output change/);
    assert.equal(loop.points, 20);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scoreSession: green e2e run proves the loop even without the phrase', () => {
  const root = tmp('forge-score-e2e-');
  try {
    const { sessionDir, session } = makeSession(root, { slug: 'jobs-loop' });
    fs.writeFileSync(
      path.join(sessionDir, 'spine.json'),
      `${JSON.stringify(validSpine([validRow()]), null, 2)}\n`,
      'utf8',
    );
    // Evidence deliberately avoids the words "product loop" — before the fix
    // this session scored 0/20 despite an executed green run.
    fs.writeFileSync(
      path.join(sessionDir, 'verify-evidence.md'),
      '# Verify\n\n## What the evidence actually proves\n\nReverted the fix, reproduced the broken row, re-applied, ran the loop green.\n',
      'utf8',
    );
    const steps = [{ name: 'probe', cmd: 'node -e "console.log(1)"' }];
    fs.writeFileSync(
      path.join(sessionDir, 'e2e.json'),
      `${JSON.stringify({ change: null, notApplicable: null, steps }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(sessionDir, 'e2e-results.json'),
      `${JSON.stringify({ ok: true, stepsHash: e2eStepsHash(steps), steps: [{ name: 'probe', ok: true, exitCode: 0 }] }, null, 2)}\n`,
      'utf8',
    );
    const card = scoreSession({ cwd: root, sessionDir, session });
    const loop = card.checks.find((c) => c.id === 'product_loop');
    assert.ok(loop.points >= 8, `expected >= 8 loop points, got ${loop.points}`);
    assert.match(loop.notes.join('\n'), /proven by execution/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('forge cleanup harvests scorecard.json into the ledger before pruning', () => {
  const root = tmp('forge-cleanup-harvest-');
  try {
    const { sessionDir, session } = makeSession(root, { phase: 'done' });
    // A scorecard as an older (pre-ledger) forgekit would have written it.
    fs.writeFileSync(
      path.join(sessionDir, 'scorecard.json'),
      `${JSON.stringify({
        scoredAt: '2026-06-01T00:00:00.000Z',
        sessionId: session.id,
        slug: session.slug,
        openspecChange: null,
        score: 83,
        maxScore: 100,
        grade: 'B',
        integrityOk: true,
        caps: [],
        checks: [{ id: 'spine', label: 'Spine matrix quality', points: 20, max: 25, notes: ['one row thin'] }],
      }, null, 2)}\n`,
      'utf8',
    );
    execFileSync(process.execPath, [CLEANUP_SCRIPT, '--include-active'], {
      cwd: root,
      env: { ...process.env, FORGEKIT_FLEET_DIR: path.join(root, 'fleet') },
    });
    assert.equal(fs.existsSync(sessionDir), false);
    const ledger = path.join(root, '.forge', 'scorecards.jsonl');
    const lines = fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.sessionId, session.id);
    assert.equal(entry.grade, 'B');
    assert.equal(entry.deductions[0].id, 'spine');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeSessionScorecard writes json and md', () => {
  const root = tmp('forge-score-write-');
  try {
    const { sessionDir, session } = makeSession(root, { slug: 'docs-only' });
    fs.writeFileSync(
      path.join(sessionDir, 'spine.json'),
      `${JSON.stringify({ rows: [], notApplicable: 'docs-only' }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# ok\n', 'utf8');
    const { jsonPath, mdPath, card } = writeSessionScorecard({ cwd: root, sessionDir, session });
    assert.equal(fs.existsSync(jsonPath), true);
    assert.equal(fs.existsSync(mdPath), true);
    assert.equal(JSON.parse(fs.readFileSync(jsonPath, 'utf8')).grade, card.grade);

    // Durable ledger: one line per session, re-scoring replaces (not appends).
    const ledger = path.join(root, '.forge', 'scorecards.jsonl');
    assert.equal(fs.existsSync(ledger), true);
    writeSessionScorecard({ cwd: root, sessionDir, session });
    const lines = fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.sessionId, session.id);
    assert.equal(entry.grade, card.grade);
    assert.ok(Array.isArray(entry.deductions));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('re-scoring heals the cached score on session.json instead of leaving three answers', () => {
  // scorecard.json, the sessions.jsonl digest and session.json all carry the
  // score. Only the first two were rewritten, so `forge score --write` on a
  // finished session left session.json asserting the old number — observed as
  // 97/A on session.json against 69/C in the scorecard. Same shape as
  // ADR-0002: a derived cache heals when it diverges.
  const root = tmp('forge-score-heal-');
  try {
    const { sessionDir, session } = makeSession(root, {
      slug: 'docs-only',
      score: 97,
      scoreGrade: 'A',
    });
    fs.writeFileSync(
      path.join(sessionDir, 'spine.json'),
      `${JSON.stringify({ rows: [], notApplicable: 'docs-only' }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# ok\n', 'utf8');
    const sessionFile = path.join(sessionDir, 'session.json');
    const before = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));

    const { card } = writeSessionScorecard({ cwd: root, sessionDir, session });
    assert.notEqual(card.score, 97, 'fixture must actually score differently, or this proves nothing');

    const after = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(after.score, card.score);
    assert.equal(after.scoreGrade, card.grade);
    assert.equal(session.score, card.score, 'the in-memory object is healed too');
    assert.equal(session.scoreGrade, card.grade);
    assert.equal(
      after.updatedAt,
      before.updatedAt,
      're-scoring is not activity — bumping updatedAt would reset idle/STALE detection',
    );
    assert.equal(after.slug, before.slug, 'nothing else on the session is rewritten');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('healing the cached score never costs the scorecard', () => {
  const root = tmp('forge-score-heal-fail-');
  try {
    const { sessionDir, session } = makeSession(root, { slug: 'docs-only' });
    fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# ok\n', 'utf8');
    // An unwritable session.json is the one failure the heal cannot dodge.
    fs.rmSync(path.join(sessionDir, 'session.json'));
    fs.mkdirSync(path.join(sessionDir, 'session.json'));

    const { card, jsonPath } = writeSessionScorecard({ cwd: root, sessionDir, session });
    assert.ok(fs.existsSync(jsonPath), 'the scorecard is still written');
    assert.equal(JSON.parse(fs.readFileSync(jsonPath, 'utf8')).grade, card.grade);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('forge phase done writes scorecard and stamps session.scoreGrade', () => {
  const root = tmp('forge-score-phase-');
  try {
    const { sessionDir } = makeSession(root, {
      slug: 'add-health',
      phase: 'verify',
      tasksTotal: 1,
      tasksComplete: 1,
    });
    fs.writeFileSync(
      path.join(sessionDir, 'spine.json'),
      `${JSON.stringify({ rows: [], notApplicable: 'sync HTTP only' }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# ok\n', 'utf8');

    execFileSync(process.execPath, [PHASE_SCRIPT, 'done'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    assert.equal(fs.existsSync(path.join(sessionDir, 'scorecard.md')), true);
    assert.equal(fs.existsSync(path.join(sessionDir, 'scorecard.json')), true);
    const session = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'));
    assert.equal(session.phase, 'done');
    assert.ok(typeof session.score === 'number');
    assert.ok(['A', 'B', 'C', 'D', 'F'].includes(session.scoreGrade));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('forge score CLI prints JSON', () => {
  const root = tmp('forge-score-cli-');
  try {
    const { sessionDir } = makeSession(root, { slug: 'add-health' });
    fs.writeFileSync(
      path.join(sessionDir, 'spine.json'),
      `${JSON.stringify({ rows: [], notApplicable: 'sync HTTP only' }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# ok\n', 'utf8');
    const out = execFileSync(process.execPath, [SCORE_SCRIPT], {
      cwd: root,
      encoding: 'utf8',
    });
    const card = JSON.parse(out);
    assert.ok(card.grade);
    assert.ok(Array.isArray(card.humanPrompts));
    assert.equal(card.humanPrompts.length, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
