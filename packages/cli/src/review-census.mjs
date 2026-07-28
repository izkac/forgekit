#!/usr/bin/env node
/**
 * Census of a session's review artifacts.
 *
 * Its own module because both the scorer and the durable ledger need it, and
 * a scorer↔ledger import cycle would force one of them into a lazy import.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * A review the coordinator wrote about its own work — a weaker signal.
 *
 * Deliberately generous: an author admitting this in their own words must be
 * believed however they phrase it. The narrow original knew only the phrases
 * the templates emit, so a group review headed "Reviewer: coordinator
 * (self-check, not independent)" was counted as an outside reader.
 */
const SELF_REVIEW_RE =
  /pace self-check|APPROVED \(pace|self[- ]review|self[- ]authored|self[- ]check|not independent|reviewed by the coordinator|dispatch(?:ing)?(?: was)? declined|no (?:independent )?reviewer(?: was)? dispatched/i;

/**
 * Who the review says reviewed it. Independence must be *claimed*, never
 * inferred, so this is the only thing that can promote a review — and the
 * claim must not name the coordinator.
 */
const REVIEWER_ATTRIBUTION_RE = /reviewer\b[\s:—*_-]*([^\n]{0,80})/i;
const COORDINATOR_RE = /coordinator|myself|in[- ]session|self/i;

/** A round that sent work back: proof the review was not a rubber stamp. */
const REJECTION_RE = /\bREJECT(ED)?\b/;

/**
 * Was this review written by someone other than the coordinator?
 *
 * Fails closed. The old rule promoted a review whenever it *lacked* a
 * self-review phrase, which inferred the strongest signal in the scorecard
 * from the absence of a word — the same "counts what is absent" mistake this
 * module was written to remove one level up. An unattributed review is
 * therefore a self-check: the cost of being wrong is one line naming the
 * reviewer, against a score that silently over-credits.
 *
 * @param {string} body
 * @returns {'independent' | 'self'}
 */
function classifyReview(body) {
  if (SELF_REVIEW_RE.test(body)) return 'self';
  const claim = REVIEWER_ATTRIBUTION_RE.exec(body);
  if (claim && !COORDINATOR_RE.test(claim[1])) return 'independent';
  return 'self';
}

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
        if (classifyReview(body) === 'independent') census.independent += 1;
        else census.selfChecks += 1;
        if (REJECTION_RE.test(body)) census.rejections += 1;
      }
    }
  }

  for (const name of ['final-review.md', 'final-review-outcome.md']) {
    const body = read(path.join(sessionDir, 'reviews', name));
    if (body === null) continue;
    census.finalReview = classifyReview(body);
    if (REJECTION_RE.test(body)) census.rejections += 1;
    break;
  }
  return census;
}
