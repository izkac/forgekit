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

// ---- 4.1b-verdict-heading: heading forms, fences, blockquotes, `or` alternatives ----

const rejected = (md) => checkReview(md).originalVerdict === 'REJECTED';
const withItem = (head) => `Reviewer: opus (task-reviewer)\n\n${head}\n\n## Important\n\n${BACKED_ITEM}\n`;

test('a "## Verdict: REJECTED" heading is a rejection', () => {
  assert.equal(rejected(withItem('## Verdict: REJECTED')), true);
  assert.equal(rejected(withItem('## **Verdict:** **REJECTED**')), true);
  assert.equal(rejected(withItem('### Verdict: REJECTED')), true);
});

test('a "## Verdict" heading followed by REJECTED on the next non-blank line is a rejection', () => {
  assert.equal(rejected(withItem('## Verdict\n\nREJECTED')), true);
  assert.equal(rejected(withItem('## Verdict\n**REJECTED**')), true);
  assert.equal(rejected(withItem('## Verdict\n\n- **REJECTED** — missing the retry path')), true);
  assert.equal(rejected(withItem('## Verdict:\n\n**REJECTED**')), true);
});

test('a "## Verdict" heading followed by APPROVED stays APPROVED', () => {
  assert.equal(rejected(withItem('## Verdict\n\nAPPROVED')), false);
  assert.equal(rejected(withItem('## Verdict\n\n**APPROVED**')), false);
  assert.equal(rejected(withItem('## Verdict: APPROVED')), false);
});

test('a "## Verdict" heading with REJECTED only further down is not a verdict', () => {
  assert.equal(rejected(withItem('## Verdict\n\nAPPROVED\n\nREJECTED would apply if the spec were missing.')), false);
});

test('REJECTED/APPROVED alternatives written as instructions are not a verdict', () => {
  for (const line of [
    'Verdict: **REJECTED** or **APPROVED**',
    '**Verdict:** **REJECTED** or **APPROVED**',
    'Verdict: REJECTED / APPROVED',
    'Verdict: REJECTED|APPROVED',
    'Verdict: **REJECTED** | **APPROVED**',
    'Verdict: REJECTED or APPROVED',
  ]) {
    assert.equal(rejected(withItem(line)), false, line);
  }
  assert.equal(rejected(withItem('## Verdict\n\nREJECTED or APPROVED')), false);
  assert.equal(rejected(withItem('## Verdict\n\n**REJECTED** / **APPROVED**')), false);
});

test('a verdict inside a code fence is not a verdict', () => {
  const quoted = '```\nVerdict: REJECTED\n```\n\n**Verdict: APPROVED**';
  assert.equal(rejected(withItem(quoted)), false);
  assert.equal(rejected(withItem('~~~\n## Verdict\nREJECTED\n~~~\n\nVerdict: APPROVED')), false);
});

test('a verdict inside a blockquote is not a verdict', () => {
  assert.equal(rejected(withItem('> Verdict: REJECTED\n\nVerdict: APPROVED')), false);
  assert.equal(rejected(withItem('> **Verdict: REJECTED**\n\n**Verdict: APPROVED**')), false);
  assert.equal(rejected(withItem('## Verdict\n> REJECTED')), false);
});

test('a real verdict after a fenced or quoted one still counts', () => {
  assert.equal(rejected(withItem('```\nVerdict: APPROVED\n```\n\nVerdict: **REJECTED**')), true);
  assert.equal(rejected(withItem('> Verdict: APPROVED\n\n## Verdict: REJECTED')), true);
});

// ---- fix round 1: NOT READY is a rejection word; a comma does not defeat the `or` rule ----

test('NOT READY reads as REJECTED in the same verdict-line forms as REJECTED', () => {
  for (const head of [
    '**Verdict: NOT READY**',
    'Verdict: NOT READY',
    'Verdict: **NOT READY**',
    '**Verdict:** NOT READY',
    '## Verdict: NOT READY',
    '- **Verdict:** **NOT READY**',
    '## Verdict\n\n**NOT READY**',
    '## Verdict\n**NOT READY** — missing wiring',
    '## Verdict\n\nNOT READY',
    '## Verdict\n\n- **NOT READY** — blockers listed below',
  ]) {
    assert.equal(rejected(withItem(head)), true, head);
  }
});

test('READY reads as approved, and NOT READY inside a fence, quote or instruction is not a verdict', () => {
  for (const head of [
    '**Verdict: READY**',
    'Verdict: READY',
    '## Verdict\n\n**READY**',
    '```\nVerdict: NOT READY\n```\n\n**Verdict: READY**',
    '> Verdict: NOT READY\n\nVerdict: READY',
    'Verdict: **NOT READY** or **READY**',
    'Verdict: NOT READY / READY',
    '## Verdict\n\nNOT READY or READY',
  ]) {
    assert.equal(rejected(withItem(head)), false, head);
  }
});

test('a comma before "or" does not make an instruction a verdict', () => {
  assert.equal(rejected(withItem('Verdict: REJECTED, or APPROVED')), false);
  assert.equal(rejected(withItem('Verdict: **REJECTED**, or **APPROVED**')), false);
  assert.equal(rejected(withItem('Verdict: NOT READY, or READY')), false);
  assert.equal(rejected(withItem('## Verdict\n\nREJECTED, or APPROVED')), false);
});
