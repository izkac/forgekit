import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { reviewCensus } from './review-census.mjs';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

/**
 * A session dir with review artifacts.
 *
 * @param {Record<string, string>} groups  `<dir>/<file>` → body
 * @param {string | null} [final]
 */
function sessionWith(groups, final = null) {
  const dir = tmp('forge-census-');
  for (const [rel, body] of Object.entries(groups)) {
    const file = path.join(dir, 'tasks', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, 'utf8');
  }
  if (final !== null) {
    fs.mkdirSync(path.join(dir, 'reviews'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'reviews', 'final-review.md'), final, 'utf8');
  }
  return dir;
}

test('independence must be claimed — an unattributed review is a self-check', () => {
  // The census exists to count what was *dispatched*. Treating "no self-review
  // phrase" as proof of an outside reader inferred the strongest signal in the
  // scorecard from the absence of a word, which is how a coordinator-written
  // group review counted as independent.
  const dir = sessionWith({
    '01-a/group-review.md': '# Group review\n\n**Verdict: APPROVED**\n\nLooks good.\n',
  });
  const census = reviewCensus(dir);

  assert.equal(census.total, 1);
  assert.equal(census.independent, 0, 'nothing here claims a dispatched reviewer');
  assert.equal(census.selfChecks, 1);
});

test('a named reviewer is independent; the coordinator naming itself is not', () => {
  // Labelled so the expected counts are derived from the fixture rather than
  // typed — the first draft of this test asserted 2/2 against 3/1 and would
  // have passed just as happily against a census that never promoted anything.
  const cases = [
    ['independent', '# Group review\n\n**Verdict: APPROVED** (opus reviewer 9f2)\n'],
    ['independent', 'Reviewer: independent task reviewer, single pass.\n\nAPPROVED\n'],
    ['independent', '**Verdict: APPROVED** — opus reviewer 4d2 read the whole diff.\n'],
    [
      'self',
      '- **Reviewer:** coordinator (**self-check, not independent**) — dispatch was declined\n',
    ],
    ['self', '# Group review\n\n**Verdict: APPROVED**\n\nNo attribution at all.\n'],
  ];
  const dir = sessionWith(
    Object.fromEntries(cases.map(([, body], i) => [`${i}-g/group-review.md`, body])),
  );
  const census = reviewCensus(dir);

  assert.equal(census.total, cases.length);
  assert.equal(census.independent, cases.filter(([kind]) => kind === 'independent').length);
  assert.equal(census.selfChecks, cases.filter(([kind]) => kind === 'self').length);
});

test('the exact wording the coordinator reaches for is read as self, however phrased', () => {
  // The old regex knew only the phrases the templates emit, so an honest
  // declaration in the author's own words slipped through as independent.
  for (const body of [
    'APPROVED (pace self-check)',
    '# Review\n\nThis is a SELF-REVIEW, not an independent one.\n',
    'Reviewer: the coordinator — reviewed by the coordinator in-session.\n',
    '**Reviewer:** coordinator (self-check, not independent)\n',
    'Reviewer: opus 4d2\n\nNote: dispatch was declined, so this is self-authored.\n',
    '# Review\n\nNo independent reviewer was dispatched for this group.\n',
  ]) {
    const dir = sessionWith({ '01-a/group-review.md': body });
    assert.equal(reviewCensus(dir).selfChecks, 1, body.slice(0, 48));
    assert.equal(reviewCensus(dir).independent, 0, body.slice(0, 48));
  }
});

test('the final review is classified by the same rule', () => {
  const independent = sessionWith({}, '# Final review\n\nReviewer: opus 4d2 — READY.\n');
  assert.equal(reviewCensus(independent).finalReview, 'independent');

  const self = sessionWith({}, '# Final review\n\nReviewer: the coordinator. This is a self-review.\n');
  assert.equal(reviewCensus(self).finalReview, 'self');

  const unclaimed = sessionWith({}, '# Final review\n\n**READY** — everything checks out.\n');
  assert.equal(
    reviewCensus(unclaimed).finalReview,
    'self',
    'an unattributed final review is not evidence of an outside reader',
  );

  assert.equal(reviewCensus(sessionWith({})).finalReview, null, 'absent is not the same as self');
});

test('rejection rounds are still counted, on either kind of review', () => {
  const dir = sessionWith(
    {
      '01-a/group-review.md':
        '**Verdict: APPROVED** (opus reviewer 9f2)\n\n## Round 1 — REJECTED\n',
    },
    '# Final review\n\nReviewer: the coordinator, self-review.\n\nRound 1 REJECTED.\n',
  );
  const census = reviewCensus(dir);
  assert.equal(census.rejections, 2);
  assert.equal(census.independent, 1);
  assert.equal(census.finalReview, 'self');
});

test('a session with no review artifacts at all counts nothing', () => {
  const census = reviewCensus(sessionWith({}));
  assert.deepEqual(census, {
    total: 0,
    independent: 0,
    selfChecks: 0,
    rejections: 0,
    finalReview: null,
  });
  assert.deepEqual(reviewCensus('/nonexistent/path'), {
    total: 0,
    independent: 0,
    selfChecks: 0,
    rejections: 0,
    finalReview: null,
  });
});
