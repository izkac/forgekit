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
    assert.match(card.caps.join(' '), /independent final review/i);

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
    assert.match(selfFinal.caps.join(' '), /self-authored/i);

    // An independent final review lifts it.
    fs.writeFileSync(
      path.join(sessionDir, 'reviews', 'final-review.md'),
      '# Final review\n\n**Verdict: APPROVED** — opus reviewer 4d2 read the whole diff.\n',
      'utf8',
    );
    const reviewed = scoreSession({ cwd: root, sessionDir, session });
    assert.equal(
      reviewed.caps.some((c) => /final review/i.test(c)),
      false,
    );
    assert.ok(reviewed.score > 69, `expected no cap, got ${reviewed.score}`);
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
    assert.match(card.caps.join(' '), /independent final review/i);
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
    assert.equal(
      bland.caps.some((c) => /final review/i.test(c)),
      false,
      `unexpected cap: ${bland.caps.join(' ')}`,
    );

    // Same fixture, one risky sentence added: the cap appears and the score
    // drops. Comparing the two is what shows the union discriminates rather
    // than simply capping everything it can now read.
    fs.writeFileSync(
      path.join(root, 'specs', 'changes', 'my-change', 'proposal.md'),
      '# Proposal\n\nHarvest token counts, and add an auth token exchange for payments.\n',
      'utf8',
    );
    const risky = scoreSession({ cwd: root, sessionDir, session });
    assert.match(risky.caps.join(' '), /independent final review/i);
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
    assert.match(card.caps.join(' '), /e2e|product loop/i);
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
    assert.ok(card.caps.some((c) => /incompleteReason/.test(c)));
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
