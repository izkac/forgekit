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
 * REVERTED in 0.3.26. 0.3.24 made this fail closed: independence had to be
 * claimed via a `Reviewer:` attribution, and anything unattributed counted as a
 * self-check. An independent review measured that in the field and it was wrong
 * in both directions — a dispatched review heading with `Reviewed:` (no such
 * token) demoted, while `coordinator self-audit` promoted because that phrase is
 * not listed here. `set-phase.mjs` gates `forge phase done` on the same
 * function, so a high-risk session whose independent final review already
 * existed was refused with the remedy already followed.
 *
 * Blocking correct work is worse than flattering a score, so this is back to
 * the pre-0.3.24 reading and finding F9 (self-authored reviews can still count
 * as independent) is reopened.
 *
 * The alternatives beyond the original four are load-bearing: the skill tells
 * coordinators to head a self-written review `Reviewer: coordinator —
 * self-check`, and the live corpus uses `coordinator self-audit`. An
 * unrecognised declaration reads as *independent*, so a phrase Forge itself
 * prescribes would otherwise defeat the money/auth done gate.
 *
 * They are matched against the **attribution region only** — the header block
 * and any line that opens with an attribution — never the whole body. A first
 * attempt scanned everything and demoted a dispatched reviewer who merely
 * *discussed* the coordinator's self-checks, which is the ordinary thing to do
 * when reviewing a change that has some. That is not a scoring nudge: the same
 * function gates `forge phase done`, so it refused correct work — C1's exact
 * failure class, reintroduced by C1's own fix. An earlier version of this
 * comment claimed a new alternative "can only ever demote, never promote —
 * the safe direction". In this module demotion *is* the unsafe direction. The real fix is structural — a stamp Forge
 * writes when it dispatches — not a wider regex; prose cannot measure
 * authorship, which is what both attempts have now demonstrated.
 */
const SELF_REVIEW_RE =
  /APPROVED \(pace|self[- ]review|self[- ]check|self[- ]audit|self[- ]authored|reviewed by the coordinator/i;

/**
 * A line that opens by naming who reviewed — not prose that mentions one.
 *
 * The `^` anchor is the whole distinction: "the reviewer proved the gap" is a
 * sentence about a reviewer, "Reviewer: opus 4d2" is an attribution.
 */
const ATTRIBUTION_LINE_RE = /^[\s#*_-]*(?:\*\*)?\s*(?:reviewer|reviewed by|review by)\b/i;

/** A fence opening or closing, at any indent markdown accepts. */
const FENCE_RE = /^\s{0,3}(?:```|~~~)/;

/**
 * The part of a review that speaks about who wrote it.
 *
 * TWO PARAGRAPHS, NOT TWO LINES. A real declaration in this project's corpus
 * hard-wraps across three lines — `**Reviewer:** the coordinator, … dispatch
 * was / declined twice … so this is a self-review` — and a line-counted window
 * stopped before the word that mattered, promoting a session that says in
 * plain English that dispatch was declined. That is the same failure the
 * `contract` narrowing was reverted for: prose wraps, regexes do not.
 *
 * Plus any attribution line anywhere, so a declaration far down the file still
 * counts — except a fenced, quoted or indented one, which is a reviewer
 * *showing* you another review's header rather than declaring their own.
 *
 * Body prose is deliberately out of scope in both directions: describing which
 * groups were self-checked is a reviewer doing their job, and demoting them for
 * it refuses correct work at the done gate.
 *
 * @param {string} body
 * @returns {string}
 */
function attributionRegion(body) {
  const lines = body.split('\n');
  /** @type {string[]} */
  const kept = [];
  /** @type {string[]} */
  const attributions = [];
  let paragraphs = 0;
  let inParagraph = false;
  let fenced = false;

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      fenced = !fenced;
      continue;
    }
    const quoted = fenced || /^\s*>/.test(line) || /^\s{4,}\S/.test(line);
    if (!line.trim()) {
      if (inParagraph) paragraphs += 1;
      inParagraph = false;
      continue;
    }
    inParagraph = true;
    if (quoted) continue;
    if (paragraphs < 2) kept.push(line);
    else if (ATTRIBUTION_LINE_RE.test(line)) attributions.push(line);
  }
  return kept.concat(attributions).join('\n');
}

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
        if (SELF_REVIEW_RE.test(attributionRegion(body))) census.selfChecks += 1;
        else census.independent += 1;
        if (REJECTION_RE.test(body)) census.rejections += 1;
      }
    }
  }

  for (const name of ['final-review.md', 'final-review-outcome.md']) {
    const body = read(path.join(sessionDir, 'reviews', name));
    if (body === null) continue;
    census.finalReview = SELF_REVIEW_RE.test(attributionRegion(body)) ? 'self' : 'independent';
    if (REJECTION_RE.test(body)) census.rejections += 1;
    break;
  }
  return census;
}
