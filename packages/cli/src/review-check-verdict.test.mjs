/**
 * Verdict-line shapes `checkReview` must read (cost-levers fix round 1, task 2.1).
 *
 * The group-3 review wrote `Verdict: **REJECTED**` (bold on the word, not the
 * whole line) and `forge review-check` reported APPROVED for that very review.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkReview, REJECTION_RE } from './review-check.mjs';

const BACKED_ITEM = '- Foo breaks on empty input.\n  Command: npm test -- foo → exit 1';

/** The review shape the group reviewer wrote: attribution, title, verdict line, a backed Important item. */
function review(verdictLine, { prose = '' } = {}) {
  return [
    'Reviewer: claude-sonnet-5-5 (task-reviewer)',
    '',
    '# Group 3 review',
    '',
    verdictLine,
    '',
    prose,
    '## Important',
    '',
    BACKED_ITEM,
    '',
  ].join('\n');
}

const SHAPES = [
  'Verdict: **REJECTED**',
  '**Verdict:** REJECTED',
  'Verdict: REJECTED',
  '**Verdict: REJECTED**',
  'verdict: rejected',
  '- **Verdict:** **REJECTED**',
];

for (const shape of SHAPES) {
  test(`checkReview reads "${shape}" as REJECTED`, () => {
    const r = checkReview(review(shape));
    assert.equal(r.originalVerdict, 'REJECTED');
    assert.equal(r.effectiveVerdict, 'REJECTED', 'the item is backed, so the rejection stands');
    assert.equal(REJECTION_RE.test(review(shape)), true);
  });
}

test('an APPROVED verdict line is not a rejection, in any of the same shapes', () => {
  for (const shape of ['Verdict: **APPROVED**', '**Verdict:** APPROVED', 'Verdict: APPROVED']) {
    assert.equal(checkReview(review(shape)).originalVerdict, 'APPROVED', shape);
  }
});

test('REJECTED inside instructional prose is not a verdict', () => {
  const prose = [
    'The verdict: REJECTED is only valid when an item is backed.',
    'Write the Verdict: REJECTED or APPROVED on its own line.',
    'Verdict: REJECTED or APPROVED',
    'A reviewer who is not sure must not say REJECTED.',
    '',
  ].join('\n');
  const r = checkReview(review('Verdict: **APPROVED**', { prose }));
  assert.equal(r.originalVerdict, 'APPROVED');
});
