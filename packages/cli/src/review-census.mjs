#!/usr/bin/env node
/**
 * Census of a session's review artifacts.
 *
 * Its own module because both the scorer and the durable ledger need it, and
 * a scorer↔ledger import cycle would force one of them into a lazy import.
 */

import fs from 'node:fs';
import path from 'node:path';

/** A review the coordinator wrote about its own work — a weaker signal. */
const SELF_REVIEW_RE = /pace self-check|APPROVED \(pace|self-review|reviewed by the coordinator/i;
/** A round that sent work back: proof the review was not a rubber stamp. */
const REJECTION_RE = /\bREJECT(ED)?\b/;

/**
 * Census of the review artifacts on disk.
 *
 * Counts what was *dispatched*, not what is absent: the previous version
 * started at full marks and only ever subtracted, so a session with no
 * reviewer of any kind scored 5/5 — which is how a 38-task, high-risk,
 * self-reviewed session reached 100/100.
 *
 * @param {string} sessionDir
 */
export function reviewCensus(sessionDir) {
  const census = { total: 0, independent: 0, selfChecks: 0, rejections: 0, finalReview: null };
  /** @param {string} file */
  const read = (file) => {
    if (!fs.existsSync(file)) return null;
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  };

  const tasksDir = path.join(sessionDir, 'tasks');
  if (fs.existsSync(tasksDir)) {
    for (const e of fs.readdirSync(tasksDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      for (const name of ['task-review.md', 'group-review.md']) {
        const body = read(path.join(tasksDir, e.name, name));
        if (body === null) continue;
        census.total += 1;
        if (SELF_REVIEW_RE.test(body)) census.selfChecks += 1;
        else census.independent += 1;
        if (REJECTION_RE.test(body)) census.rejections += 1;
      }
    }
  }

  for (const name of ['final-review.md', 'final-review-outcome.md']) {
    const body = read(path.join(sessionDir, 'reviews', name));
    if (body === null) continue;
    census.finalReview = SELF_REVIEW_RE.test(body) ? 'self' : 'independent';
    if (REJECTION_RE.test(body)) census.rejections += 1;
    break;
  }
  return census;
}
