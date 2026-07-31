import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { buildFleetReport, formatFleetReport } from './fleet-report.mjs';
import { CENSUS_RULE } from './review-census.mjs';

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
}

/** A project with a scorecards ledger and (optionally) session digests. */
function makeProject(name, { scores = [], digests = [], deferrals = [] } = {}) {
  const root = tmp(`fleet-report-${name}-`);
  if (scores.length) writeJsonl(path.join(root, '.forge', 'scorecards.jsonl'), scores);
  if (digests.length) writeJsonl(path.join(root, '.forge', 'sessions.jsonl'), digests);
  if (deferrals.length) writeJsonl(path.join(root, '.forge', 'deferrals.jsonl'), deferrals);
  return { project: root, projectName: name };
}

test('the report aggregates scores, grades and deductions across projects', () => {
  const a = makeProject('volo', {
    scores: [
      { sessionId: 's1', slug: 'one', score: 90, grade: 'A', caps: [], deductions: [{ id: 'product_loop', points: 11, max: 20 }] },
      { sessionId: 's2', slug: 'two', score: 80, grade: 'B', caps: [], deductions: [{ id: 'product_loop', points: 0, max: 20 }] },
    ],
  });
  const b = makeProject('helm', {
    scores: [{ sessionId: 's3', slug: 'three', score: 97, grade: 'A', caps: [], deductions: [{ id: 'product_loop', points: 17, max: 20 }] }],
  });

  const report = buildFleetReport([a, b]);

  assert.equal(report.totals.sessions, 3);
  assert.equal(report.totals.meanScore, 89);
  assert.deepEqual(report.totals.grades, { A: 2, B: 1 });
  // The deduction that costs the most points across the fleet leads.
  assert.equal(report.totals.topDeductions[0].id, 'product_loop');
  assert.equal(report.totals.topDeductions[0].lostPoints, 32);
  assert.equal(report.projects.length, 2);
  assert.equal(report.projects.find((p) => p.projectName === 'helm').meanScore, 97);
});

test('caps are counted, because a capped session is a process failure worth trending', () => {
  const p = makeProject('volo', {
    scores: [
      { sessionId: 's1', score: 69, grade: 'C', caps: ['high-risk session whose final review is self-authored — score capped at 69'], deductions: [] },
      { sessionId: 's2', score: 97, grade: 'A', caps: [], deductions: [] },
    ],
  });
  const report = buildFleetReport([p]);
  assert.equal(report.totals.capped, 1);
  assert.match(report.totals.capReasons[0], /self-authored/);
});

test('digests surface review coverage and rejection rounds next to the grade', () => {
  const p = makeProject('helm', {
    scores: [{ sessionId: 's1', score: 97, grade: 'A', caps: [], deductions: [] }],
    digests: [
      {
        sessionId: 's1',
        slug: 'phase-0',
        reviews: { total: 9, independent: 9, selfChecks: 0, rejections: 4, final: 'independent' },
        subagentsDispatched: 18,
        checkpoints: 3,
        health: 'done',
        durationHours: 1.2,
      },
    ],
  });
  const report = buildFleetReport([p]);
  assert.equal(report.totals.reviews.independent, 9);
  assert.equal(report.totals.reviews.rejections, 4);
  assert.equal(report.totals.subagents, 18);
  assert.equal(report.projects[0].sessions[0].grade, 'A');
});

test('open deferrals across projects are listed — carried debt is fleet-level', () => {
  const p = makeProject('volo', {
    scores: [{ sessionId: 's1', score: 90, grade: 'A', caps: [], deductions: [] }],
    deferrals: [
      { sessionId: 's1', task: '7.1', reason: 'grouping.ts D1 extraction', change: 'add-x' },
      { sessionId: 's1', task: '9.2', reason: 'PATCH /settings flattens 400s into 500s', change: 'add-x' },
    ],
  });
  const report = buildFleetReport([p]);
  assert.equal(report.totals.openDeferrals, 2);
  assert.match(report.openDeferrals[0].reason, /grouping\.ts/);
});

test('a project with no ledgers contributes nothing and does not throw', () => {
  const empty = makeProject('fresh');
  const report = buildFleetReport([empty]);
  assert.equal(report.totals.sessions, 0);
  assert.equal(report.projects.length, 0, 'projects with no scored sessions are omitted');
  assert.match(formatFleetReport(report), /No scored sessions/);
});

test('the rendered report leads with the fleet summary', () => {
  const p = makeProject('volo', {
    scores: [{ sessionId: 's1', slug: 'one', score: 69, grade: 'C', caps: ['capped'], deductions: [{ id: 'reviews', points: 2, max: 5 }] }],
  });
  const text = formatFleetReport(buildFleetReport([p]));
  assert.match(text, /1 session/);
  assert.match(text, /volo/);
  assert.match(text, /reviews/);
});

test('review totals from different census rules are flagged, not silently summed', () => {
  // Four classifiers wrote verdicts in one day. Adding `independent` across
  // rules produces a number with no meaning, and the report used to print it
  // with the same confidence as a single-rule total.
  const mixed = makeProject('mixed', {
    scores: [{ sessionId: 'a', score: 90, grade: 'A' }, { sessionId: 'b', score: 80, grade: 'B' }],
    digests: [
      { sessionId: 'a', reviews: { independent: 2, selfChecks: 0, rejections: 0, final: 'independent', rule: 3 } },
      { sessionId: 'b', reviews: { independent: 1, selfChecks: 1, rejections: 0, final: 'self' } },
    ],
  });
  const report = buildFleetReport([mixed]);

  assert.deepEqual(report.totals.reviews.rules, [0, 3], 'a missing rule is rule 0, not absent');
  assert.equal(report.totals.reviews.mixedRules, true);
  assert.match(formatFleetReport(report), /mixed census rules/i);

  const uniform = makeProject('uniform', {
    scores: [{ sessionId: 'a', score: 90, grade: 'A' }],
    digests: [{ sessionId: 'a', reviews: { independent: 2, selfChecks: 0, rejections: 0, final: 'independent', rule: 3 } }],
  });
  const clean = buildFleetReport([uniform]);
  assert.deepEqual(clean.totals.reviews.rules, [3]);
  assert.equal(clean.totals.reviews.mixedRules, false);
  assert.doesNotMatch(formatFleetReport(clean), /mixed census rules/i);
});

/**
 * A digest line carrying a final-review verdict. `evidence` is omitted
 * entirely when passed `undefined`, which is what every line written before
 * the field existed looks like.
 */
function verdictLine(sessionId, evidence, final = 'independent') {
  const reviews = { total: 1, independent: 1, selfChecks: 0, rejections: 0, final, rule: CENSUS_RULE };
  if (evidence !== undefined) reviews.evidence = evidence;
  return { sessionId, reviews };
}

/** Scorecard rows for the given session ids — a project needs them to count. */
function scoresFor(ids) {
  return ids.map((sessionId, i) => ({ sessionId, score: 90 - i, grade: 'A', caps: [], deductions: [] }));
}

test('review totals measured different ways are flagged, not silently summed', () => {
  // `CENSUS_RULE` cannot catch this and no future rule number can: rule 4 is
  // *defined* as "host evidence where available, prose otherwise", so a rule-4
  // line carries either kind permanently. Measured across 20 real sessions on
  // this machine, the frozen grades split 1 host / 7 inferred / 12 none. The
  // discriminator has to be per line.
  const graded = makeProject('graded', {
    scores: scoresFor(['measured', 'read']),
    digests: [verdictLine('measured', 'host'), verdictLine('read', 'inferred')],
  });
  const report = buildFleetReport([graded]);

  assert.deepEqual(report.totals.reviews.evidence, ['host', 'inferred']);
  assert.equal(report.totals.reviews.mixedEvidence, true);
  assert.equal(
    report.totals.reviews.mixedRules,
    false,
    'one census rule — so the rule mechanism cannot be what flags this',
  );
  assert.match(formatFleetReport(report), /mixed authorship evidence/i);

  const uniform = makeProject('uniform-grade', {
    scores: scoresFor(['a', 'b']),
    digests: [verdictLine('a', 'host'), verdictLine('b', 'host')],
  });
  const clean = buildFleetReport([uniform]);
  assert.deepEqual(clean.totals.reviews.evidence, ['host']);
  assert.equal(clean.totals.reviews.mixedEvidence, false);
  assert.doesNotMatch(formatFleetReport(clean), /mixed authorship evidence/i);
});

test('the `recorded` grade (F12\'s dispatch stamp, read back by census rule 5) sorts and flags like any other', () => {
  // Nothing here is specific to `recorded` — `t.reviews.evidence` and the
  // mixed-authorship warning both generalize to any string `reviewCensus` can
  // grade — but that genericness is exactly what a new grade could quietly
  // break (a hard-coded `['host', 'inferred']` allowlist, for instance), so
  // this pins that `recorded` really does flow through unmodified.
  const p = makeProject('stamped', {
    scores: scoresFor(['stamped', 'measured']),
    digests: [verdictLine('stamped', 'recorded'), verdictLine('measured', 'host')],
  });
  const report = buildFleetReport([p]);

  assert.deepEqual(report.totals.reviews.evidence, ['host', 'recorded']);
  assert.equal(report.totals.reviews.mixedEvidence, true);
  assert.match(formatFleetReport(report), /mixed authorship evidence/i);
});

test('a digest line written before evidence was recorded reads as unknown, never as a grade', () => {
  // Folding a missing grade into `inferred` — or into any other bucket —
  // would be this change's own defect class committed in the one file that
  // reports across projects: an absence of signal turned into a signal.
  const legacy = makeProject('legacy', {
    scores: scoresFor(['old', 'new']),
    digests: [verdictLine('old', undefined), verdictLine('new', 'host')],
  });
  const report = buildFleetReport([legacy]);

  assert.deepEqual(report.totals.reviews.evidence, ['host', 'unknown']);
  assert.equal(report.totals.reviews.mixedEvidence, true);
  assert.equal(
    report.totals.reviews.finalIndependent,
    2,
    'both verdicts are still counted — this warns about comparability, it does not drop data',
  );

  // A fleet that is uniformly pre-3.2 is internally consistent and must not
  // acquire a warning it cannot act on.
  const allLegacy = makeProject('all-legacy', {
    scores: scoresFor(['a', 'b']),
    digests: [verdictLine('a', undefined), verdictLine('b', undefined)],
  });
  const old = buildFleetReport([allLegacy]);
  assert.deepEqual(old.totals.reviews.evidence, ['unknown']);
  assert.equal(old.totals.reviews.mixedEvidence, false);
});

test('a grade that is not a readable string is unknown, never pushed as a grade', () => {
  // `evidence` arrives from a JSON line on disk, so its type is not ours to
  // assume. A number, a null, an empty string or a nested object cannot name a
  // way of measuring review authorship. Pushing one through would report `42`
  // as a grade and — worse — a second bogus value would raise `mixedEvidence`
  // on a fleet that is in fact uniform, or mask a real mix behind noise.
  for (const bogus of [42, null, '', { grade: 'host' }, ['host'], true]) {
    const p = makeProject('bogus', {
      scores: scoresFor(['a', 'b']),
      digests: [verdictLine('a', bogus), verdictLine('b', 'host')],
    });
    assert.deepEqual(
      buildFleetReport([p]).totals.reviews.evidence,
      ['host', 'unknown'],
      `evidence: ${JSON.stringify(bogus)}`,
    );
  }

  // And the warning must not tell the operator which kind of unknown it is:
  // a legacy line and a corrupt one are indistinguishable here by construction.
  const mixed = makeProject('bogus-text', {
    scores: scoresFor(['a', 'b']),
    digests: [verdictLine('a', 42), verdictLine('b', 'host')],
  });
  const text = formatFleetReport(buildFleetReport([mixed]));
  assert.match(text, /mixed authorship evidence/i);
  assert.doesNotMatch(
    text,
    /"unknown" is a session finished before/i,
    'the line must not claim to know which kind of unreadable grade it saw',
  );
});

test('a self verdict carries a grade too — both totals are summed, so both are graded', () => {
  // Half the stated invariant, and until this fixture existed no test anywhere
  // attached a grade to a `self` line: every one of them graded an
  // `independent`. `finalSelf` is summed exactly like `finalIndependent`, so a
  // host-measured `self` beside a prose-inferred `independent` is a genuinely
  // incomparable pair and must be flagged.
  const p = makeProject('graded-self', {
    scores: scoresFor(['measured-self', 'read-independent']),
    digests: [
      verdictLine('measured-self', 'host', 'self'),
      verdictLine('read-independent', 'inferred', 'independent'),
    ],
  });
  const report = buildFleetReport([p]);

  assert.equal(report.totals.reviews.finalSelf, 1);
  assert.equal(report.totals.reviews.finalIndependent, 1);
  assert.deepEqual(report.totals.reviews.evidence, ['host', 'inferred']);
  assert.equal(report.totals.reviews.mixedEvidence, true);

  // And a `self` line is the one that can carry the missing grade too.
  const legacySelf = makeProject('legacy-self', {
    scores: scoresFor(['old-self', 'new-self']),
    digests: [verdictLine('old-self', undefined, 'self'), verdictLine('new-self', 'host', 'self')],
  });
  assert.deepEqual(buildFleetReport([legacySelf]).totals.reviews.evidence, ['host', 'unknown']);
});

test('a line with no final verdict contributes no evidence grade to compare', () => {
  // `final: null` is graded `none` — there was no final review to judge — and
  // it adds nothing to either verdict total, so it cannot make them
  // incomparable. Counting it would fire the warning on almost every fleet:
  // 12 of the 20 real sessions measured on this machine have no final review.
  const p = makeProject('nofinal', {
    scores: scoresFor(['a', 'b']),
    digests: [verdictLine('a', 'host'), verdictLine('b', 'none', null)],
  });
  const report = buildFleetReport([p]);
  assert.deepEqual(report.totals.reviews.evidence, ['host']);
  assert.equal(report.totals.reviews.mixedEvidence, false);
});

test('a rule-3 digest line and one written by the current rule are reported as mixed', () => {
  // The mixed-rule mechanism itself shipped in 0.3.28 and is covered above.
  // This asserts the CENSUS_RULE bump is *wired*: host dispatch evidence now
  // decides `final`, so a verdict 0.3.27 derived from prose is a different
  // measurement and must not be summed with one produced today. Were the
  // constant left at 3 both lines would carry the same rule, `rules` would
  // dedupe to one entry and the fleet would silently add them together.
  const RULE_3 = 3; // 0.3.27 — the last prose-only classifier
  const line = (sessionId, rule) => ({
    sessionId,
    reviews: { total: 1, independent: 1, selfChecks: 0, rejections: 0, final: 'independent', rule },
  });
  const fleet = makeProject('census-bump', {
    scores: [
      { sessionId: 'old', score: 90, grade: 'A' },
      { sessionId: 'new', score: 80, grade: 'B' },
    ],
    digests: [line('old', RULE_3), line('new', CENSUS_RULE)],
  });

  const report = buildFleetReport([fleet]);
  assert.deepEqual(
    report.totals.reviews.rules,
    [RULE_3, CENSUS_RULE],
    'the current rule must be past 3 — a prose verdict and an evidence verdict are not one scale',
  );
  assert.equal(report.totals.reviews.mixedRules, true);
  assert.match(formatFleetReport(report), /mixed census rules/i);
});
