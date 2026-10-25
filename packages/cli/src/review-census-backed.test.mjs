import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { REJECTION_RE, reviewCensus } from './review-census.mjs';
import { checkReview } from './review-check.mjs';

/** A session dir holding `tasks/<rel>` review files and an optional final review. */
function sessionWith(groups, final = null) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'forge-census-backed-'));
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

const HEAD = 'Reviewer: opus 4d2\n\n**Verdict: REJECTED**\n\n';
const UNBACKED = `${HEAD}## Important\n\n- The retry loop looks fragile.\n`;
const BACKED = `${HEAD}## Important\n\n- Retry loop throws.\n  Command: npm test -- retry → exit 1\n`;
const MINOR_ONLY = `${HEAD}## Minor\n\n- Rename a variable.\n`;

test('fixtures: both reviews are REJECTED by the verdict line, only the backed one stays REJECTED', () => {
  assert.ok(REJECTION_RE.test(UNBACKED) && REJECTION_RE.test(BACKED));
  assert.equal(checkReview(UNBACKED).effectiveVerdict, 'APPROVED');
  assert.equal(checkReview(BACKED).effectiveVerdict, 'REJECTED');
});

test('an unbacked REJECTED group review is not a rejection; a backed one is', () => {
  const unbacked = reviewCensus(sessionWith({ '01-a/group-review.md': UNBACKED }));
  const backed = reviewCensus(sessionWith({ '01-a/group-review.md': BACKED }));
  assert.equal(unbacked.rejections, 0);
  assert.equal(backed.rejections, 1);
});

test('the task-review.md file name is counted by the same rule', () => {
  const unbacked = reviewCensus(sessionWith({ '01-a/task-review.md': UNBACKED }));
  const backed = reviewCensus(sessionWith({ '01-a/task-review.md': BACKED }));
  assert.equal(unbacked.rejections, 0);
  assert.equal(backed.rejections, 1);
});

test('a REJECTED review with only Minor items is not a rejection; one with no parseable findings still is', () => {
  const minor = reviewCensus(sessionWith({ '01-a/group-review.md': MINOR_ONLY }));
  const bare = reviewCensus(sessionWith({ '01-a/group-review.md': '## Round 1 — REJECTED\n' }));
  assert.equal(minor.rejections, 0);
  assert.equal(bare.rejections, 1);
});

test('the final-review branch applies the same rule', () => {
  assert.equal(reviewCensus(sessionWith({}, UNBACKED)).rejections, 0);
  assert.equal(reviewCensus(sessionWith({}, BACKED)).rejections, 1);
});

test('rejections add across group reviews and the final review, counting only backed ones', () => {
  const dir = sessionWith(
    {
      '01-a/group-review.md': BACKED,
      '02-b/group-review.md': UNBACKED,
      '03-c/group-review.md': BACKED,
    },
    BACKED,
  );
  assert.equal(reviewCensus(dir).rejections, 3);
});

test('nothing else in the census changes: totals and authorship ignore evidence', () => {
  const dir = sessionWith(
    {
      '01-a/group-review.md': UNBACKED,
      '02-b/group-review.md': `This is a self-review.\n\n**Verdict: REJECTED**\n\n## Important\n\n- worry\n`,
    },
    UNBACKED,
  );
  const census = reviewCensus(dir);
  assert.equal(census.total, 2);
  assert.equal(census.independent, 1);
  assert.equal(census.selfChecks, 1);
  assert.equal(census.finalReview, 'independent');
  assert.equal(census.finalReviewEvidence, 'inferred');
  assert.equal(census.rejections, 0);
});
