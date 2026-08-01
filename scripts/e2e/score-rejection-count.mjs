#!/usr/bin/env node
/**
 * Product loop for score-rejection-count (F59) — plant approve-with-reject-
 * instructions vs a real Round REJECTED marker and assert reviewCensus
 * (the same counter forge score notes consume) does not count the former.
 *
 * Status line (exact): `REJECTIONS instructional=0 structural=1`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reviewCensus } from '../../packages/cli/src/review-census.mjs';

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function plantGroupReview(body) {
  const sessionDir = tmp('forgekit-e2e-score-rejection-count-');
  const reviewFile = path.join(sessionDir, 'tasks', '01-a', 'group-review.md');
  fs.mkdirSync(path.dirname(reviewFile), { recursive: true });
  fs.writeFileSync(reviewFile, body, 'utf8');
  return sessionDir;
}

// Case A: instructional "REJECT if any of" + APPROVED must not count.
const instructionalDir = plantGroupReview(
  '# Group review\n\nREJECT if any of: missing tests, broken API.\n\n**Verdict: APPROVED**\n',
);
const instructional = reviewCensus(instructionalDir);
if (instructional.rejections !== 0) {
  fail(
    `instructional: expected rejections=0, got ${instructional.rejections} ` +
      `(census must not claim a rejection round for REJECT-if + APPROVED)`,
  );
}

// Case B: structural Round REJECTED marker must count.
const structuralDir = plantGroupReview(
  '# Group review\n\n**Verdict: APPROVED**\n\n## Round 1 — REJECTED\n',
);
const structural = reviewCensus(structuralDir);
if (structural.rejections < 1) {
  fail(`structural: expected rejections>=1, got ${structural.rejections}`);
}

process.stdout.write(
  `REJECTIONS instructional=${instructional.rejections} structural=${structural.rejections}\n`,
);

fs.rmSync(instructionalDir, { recursive: true, force: true });
fs.rmSync(structuralDir, { recursive: true, force: true });
