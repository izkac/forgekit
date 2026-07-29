#!/usr/bin/env node
/**
 * Census of a session's review artifacts.
 *
 * Its own module because both the scorer and the durable ledger need it, and
 * a scorer↔ledger import cycle would force one of them into a lazy import.
 *
 * EVIDENCE BEATS TESTIMONY, FOR ONE VERDICT. `finalReview` drives the money/auth
 * `forge phase done` gate, a 29-point scorecard cap and the durable digest, and
 * until rule 4 it was decided entirely by reading the review file's prose — text
 * written by the party being judged. `SELF_REVIEW_RE` below records the four
 * rules that reading went through in one day and how each of them was wrong;
 * that history is the argument for this path, so extend it rather than replace
 * it. `metrics/review-evidence.mjs` now reports what the *host* recorded about
 * subagents it actually ran, and when that report can decide, it decides:
 * `finalReviewEvidence: 'host'`. On that path the prose is not read at all — not
 * as a tiebreak, not as a sanity check. Anything less leaves the file under
 * suspicion still able to move the verdict.
 *
 * ABSENCE OF A SIGNAL IS NOT A NEGATIVE SIGNAL, and every defect this subsystem
 * has shipped was that rule broken. Three separate absences reach this module
 * and none of them may become `self`:
 *
 *   - the caller passed no evidence, or the reader could not look
 *     (`available: false`) — fall back to prose, graded `inferred`
 *   - the host recorded dispatches but none carries the prescribed label —
 *     nobody in this repo labels their dispatches, so the host cannot answer the
 *     question either; fall back to prose, graded `inferred`
 *   - there is no final review file — `null`, graded `none`
 *
 * Only "the host looked and this session's reviewer is not there" is a negative,
 * and it is the one that produces `self` on host evidence.
 *
 * Scope is `finalReview` alone. The per-group `independent` / `selfChecks`
 * counts stay on prose deliberately: they are worth ~2 scorecard points, and
 * widening the evidence path to them would put every review artifact behind a
 * gate decision for no gain.
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
 * The last alternative names the coordinator *as the reviewer* — `**Reviewer:**
 * coordinator`, which is the skill's own phrasing minus its `self-check`
 * suffix. 0.3.26 shipped without it and a design review found the escape live:
 * a helm final review whose next words are "a final-reviewer subagent was
 * dispatched and declined by the operator" classified as **independent** on a
 * high-risk session with no waiver. Adjacency is what keeps it safe — only
 * punctuation and emphasis may sit between `reviewer` and `coordinator`, so
 * "Reviewer: claude-opus-5, dispatched by the coordinator" is untouched. The
 * trailing `(?!-)` is the other half: `Reviewer: coordinator-dispatched opus
 * subagent` uses the word as an adjective, and demoting it would refuse work.
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
// `SKIPPED \(pace` was added after the final review (I2). `phases/review.md`
// prescribes writing `SKIPPED (pace=…)` when pace skips the final review on a
// change that is not high-risk — Forge's own string, four lines above its own
// HARD-GATE — and the list recognised `APPROVED \(pace` but not it, so a review
// that explicitly records that *nobody read the change* was graded as an
// outside reader: +2 review points, no 29-point cap, and a permanent
// `{independent, inferred}` line in `sessions.jsonl` and the fleet totals.
// Not a gate escape (the instruction is conditioned on not-high-risk, and the
// gate's predicate is the same one), but it is the durable ledger recording the
// opposite of what happened.
const SELF_REVIEW_RE =
  /APPROVED \(pace|SKIPPED \(pace|self[- ]review|self[- ]check|self[- ]audit|self[- ]authored|reviewed by the coordinator|reviewer[\s*_:—–-]*(?:the\s+)?(?:coordinator|author|myself)\b(?!-)/i;

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

/**
 * Which classifier produced a verdict.
 *
 * Four rules have written verdicts into `.forge/sessions.jsonl` — in one day —
 * and nothing recorded which, so a cross-project total sums numbers that were
 * never comparable. Bump this whenever classification changes; a digest line
 * with no `rule` predates the field and is rule 0.
 *
 *   0  ≤ 0.3.23 — narrow phrase list, independent by default
 *   1  0.3.24–0.3.25 — fail closed: independence had to be claimed
 *   2  0.3.26 — inference again, self-declarations read in the attribution region
 *   3  0.3.27 — `Reviewer: coordinator` counts as a declaration
 *   4  this change (0.3.29) — the host's dispatch record decides `finalReview`
 *      where it can; prose is the fallback and is graded `inferred`
 *
 * Rule 4 is the first that is not a prose rule at all on its primary path, so a
 * rule-3 `independent` and a rule-4 `independent` are not the same measurement
 * and `fleet-report` must keep refusing to add them.
 */
export const CENSUS_RULE = 4;

/** A round that sent work back: proof the review was not a rubber stamp. */
const REJECTION_RE = /\bREJECT(ED)?\b/;

/**
 * The unit a final-review dispatch carries: `forge-review final`.
 *
 * One literal, because `reviewEvidence` lower-cases the unit it captures and
 * this is the only unit whose verdict is scoped to this change. A per-group
 * unit (`forge-review group-01`) lands in the same table and is deliberately
 * ignored here — see the scope note in the module header.
 */
const FINAL_REVIEW_UNIT = 'final';

/**
 * What the host's record says about the final review, or `null` when it cannot
 * say and the prose rule must answer instead.
 *
 * READ `available` FIRST — before `units`, `seen` or `prescribed`. On an
 * unavailable answer those three are placeholders that `reviewEvidence` sets to
 * zero to keep the shape uniform, not measurements, and no numeric value could
 * distinguish "looked and found nothing" from "could not look". A caller that
 * reads the tallies without the flag returns `self` for every session nobody
 * could measure, which at the done gate refuses correct work — the exact
 * failure this change exists to end.
 *
 * THE ADOPTION GATE is the `seen > 0, prescribed === 0` line, and it is not a
 * courtesy. **This is the one place the adoption corpus is counted**; four
 * copies of it elsewhere went stale in four different ways during one change,
 * so the others point here instead of restating it. Measured 421 sidecar metas
 * on this machine (2026-07-29): 18 carry a `forge-review` description and only
 * 4 carry the session id the matcher needs — all of them this change's own
 * reviewers. The figure moves daily and is illustrative; what does not move is
 * the shape, which is that adoption is near zero. Reading "no prescribed
 * dispatch" as "no reviewer ran" would therefore mark essentially every
 * existing session self-reviewed and refuse it at the money/auth gate.
 * Dispatches with no prescribed label among them mean the convention is not in
 * use here, so the host has no answer to give and the prose decides. Contrast
 * `seen === 0`: nothing identifiable was dispatched at all, which *is* the host
 * saying no reviewer ran.
 *
 * A STOPPED DISPATCH IS THE HOST'S RECORD OF AN OPERATOR DECLINING A REVIEWER,
 * so a unit whose only dispatch was stopped is `self` — the reviewer did not
 * finish. A unit carrying both is measured, not hypothetical: of the 29
 * repeated dispatch descriptions in that same corpus (2026-07-29), one is a
 * stopped run followed by a completed re-run of the same work — an operator
 * declining a subagent and dispatching it again. There a reviewer did run to
 * completion, so the verdict
 * is `independent` and the stop is still reported: the flag states a fact the
 * host recorded, it is not the verdict's cause. No waiver is ever applied from
 * it — declining a reviewer is the operator's decision to record, and
 * `session.finalReviewWaived` is theirs to set.
 *
 * Never throws: this runs inside `forge phase done` and telemetry must not
 * block a transition. A malformed evidence object is treated as one that cannot
 * decide, which lands on prose — the side that cannot refuse correct work.
 *
 * @param {unknown} evidence the object `reviewEvidence` returns
 * @returns {{ finalReview: 'independent' | 'self', stoppedByOperator: boolean } | null}
 *   `null` means "the host cannot answer" and never "no reviewer ran"
 */
function hostFinalReview(evidence) {
  if (!evidence || typeof evidence !== 'object') return null;
  if (/** @type {any} */ (evidence).available !== true) return null;
  const { units, seen, prescribed } = /** @type {any} */ (evidence);
  // An answer whose tallies are not numbers is not an answer. Falling through
  // to the comparisons below would make `undefined > 0` false and read as
  // "nothing was dispatched" — an absence turned into a negative again.
  if (typeof seen !== 'number' || typeof prescribed !== 'number') return null;
  if (!units || typeof units !== 'object') return null;
  if (seen > 0 && prescribed === 0) return null; // the convention is not in use

  const bucket = units[FINAL_REVIEW_UNIT];
  if (bucket === undefined) {
    // The host looked, the convention is in use, and this session's final
    // reviewer is not in the table. The one genuine negative in this function.
    return { finalReview: 'self', stoppedByOperator: false };
  }
  // PRESENT AND UNREADABLE IS NOT ABSENT — the same distinction three layers
  // above, one layer down. A record that exists but whose counts cannot be read
  // says a dispatch happened and refuses to say what it was; reading it as zero
  // dispatches would answer `self` on `host` grade, which is a confident
  // refusal at the money/auth gate built on an absence. `reviewEvidence` writes
  // both counts on every bucket it creates, so a bucket missing either is not
  // its output — and 3.2 round-trips this through JSON, where the shape stops
  // being ours. Falls back to prose, the side that cannot refuse correct work.
  if (
    typeof bucket !== 'object' ||
    bucket === null ||
    Array.isArray(bucket) ||
    typeof bucket.dispatched !== 'number' ||
    typeof bucket.stopped !== 'number'
  ) {
    return null;
  }
  return {
    finalReview: bucket.stopped >= bucket.dispatched ? 'self' : 'independent',
    stoppedByOperator: bucket.stopped > 0,
  };
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
 * @param {{ evidence?: unknown }} [options] `evidence` is the object
 *   `metrics/review-evidence.mjs`'s `reviewEvidence` returns. Omitted — as all
 *   three of today's callers omit it (`score.mjs`, `set-phase.mjs`,
 *   `ledger.mjs`; group 3 wires them) — the verdict is the prose reading this
 *   module has always done, graded `inferred`.
 * @returns {{ total: number, independent: number, selfChecks: number,
 *   rejections: number, finalReview: 'independent' | 'self' | null,
 *   finalReviewEvidence: 'host' | 'recorded' | 'inferred' | 'none',
 *   stoppedByOperator: boolean, rule: number }} `finalReviewEvidence` grades
 *   `finalReview` only, strongest first: `host` — measured from the host's own
 *   dispatch record; `recorded` — reserved for a signed attestation and not yet
 *   produced by anything; `inferred` — read off the review file's prose;
 *   `none` — there is no final review to judge. `stoppedByOperator` is a
 *   measurement only under `host`; elsewhere it is `false` as a placeholder,
 *   in the same sense `reviewEvidence` zeroes its tallies when it could not
 *   look. Read the grade before believing it.
 */
export function reviewCensus(sessionDir, options) {
  const census = {
    total: 0,
    independent: 0,
    selfChecks: 0,
    rejections: 0,
    finalReview: null,
    finalReviewEvidence: 'none',
    stoppedByOperator: false,
    rule: CENSUS_RULE,
  };
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

  // Read once, and OUTSIDE the loop below, because a stopped dispatch is a fact
  // about the session and not about the file. The likeliest way an operator
  // declines a reviewer is before it has written anything, so computing this
  // only when a review file exists reported `stoppedByOperator: false` for the
  // most probable form of the very scenario the spec names — and after the
  // freeze that false outlives the evidence in `session.json` and the digest.
  const host = hostFinalReview(options?.evidence);
  if (host) census.stoppedByOperator = host.stoppedByOperator;

  for (const name of ['final-review.md', 'final-review-outcome.md']) {
    const body = read(path.join(sessionDir, 'reviews', name));
    if (body === null) continue;
    if (host) {
      // `body` is deliberately untouched here. Evaluating the prose and then
      // discarding it would still be consulting the file under suspicion, and
      // the two tests that pin this path are written so they go red if it is.
      census.finalReview = host.finalReview;
      census.finalReviewEvidence = 'host';
    } else {
      census.finalReview = SELF_REVIEW_RE.test(attributionRegion(body)) ? 'self' : 'independent';
      census.finalReviewEvidence = 'inferred';
    }
    if (REJECTION_RE.test(body)) census.rejections += 1;
    break;
  }
  return census;
}
