/**
 * Doc contract: every closed-list self-declaration phrase published in
 * `skills/forge/phases/implement.md` must still grade as self via reviewCensus.
 * Phrases are extracted from the shipped markdown — not a parallel hard-coded list.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { reviewCensus } from './review-census.mjs';
import { runDocContract } from './review-guidance-contract.mjs';

/**
 * @param {string} finalBody
 * @returns {string} session dir
 */
function sessionWithFinal(finalBody) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'forge-doc-contract-'));
  fs.mkdirSync(path.join(dir, 'reviews'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'reviews', 'final-review.md'), finalBody, 'utf8');
  return dir;
}

test('each closed-list phrase in implement.md grades as self', () => {
  const { phrases, self } = runDocContract();
  assert.equal(self, phrases.length);
  assert.ok(phrases.length >= 1);
});

test('independent-looking prose without closed phrases is not self', () => {
  const dir = sessionWithFinal('Looks good. Independent pass.\n');
  assert.notEqual(reviewCensus(dir).finalReview, 'self');
});
