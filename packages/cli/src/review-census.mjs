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
 * TWO RECORDS, THEN THE PROSE. The host's record is not always there to read —
 * transcripts get pruned, bindings go half-readable — and rule 4's answer in
 * that case was to hand the verdict back to the file under suspicion. Rule 5
 * adds the second source: `forge review-label` writes a stamp into
 * `reviews/dispatches.json` when it prints the label for a reviewer dispatch,
 * and `readStamps` (`review-stamp.mjs`) hands it back here. Precedence is
 * **host > recorded > inferred**, and the doctrine that fixes where `recorded`
 * stops is that *the stamp substitutes for a record the host lost, never for
 * work the reviewer didn't do*. On that path too, the prose is not read.
 *
 * WHY `recorded` RANKS BELOW `host`: the stamp is written when the label is
 * printed, which is *before* any subagent exists and happens whether or not one
 * is ever dispatched. It records an intention to dispatch, where the host
 * records a dispatch that ran. So a stamp is evidence that the reviewer was
 * sent, and only the host can say what became of it — which is why a host
 * answer overrides a stamp in both directions, and why over-credit is the
 * accepted error here (the alternative refuses correct work, and this module
 * has been reverted for that twice).
 *
 * ABSENCE OF A SIGNAL IS NOT A NEGATIVE SIGNAL, and every defect this subsystem
 * has shipped was that rule broken. Three separate absences reach this module
 * and none of them may become `self`:
 *
 *   - the caller passed no evidence, or the reader could not look
 *     (`available: false`) — the stamp answers if there is one, else prose
 *   - the host recorded dispatches but none carries the prescribed label —
 *     nobody in this repo labels their dispatches, so the host cannot answer the
 *     question either; the stamp answers if there is one, else prose
 *   - there is no final review file — `null`, graded `none`, and a stamp does
 *     not change that: it records a dispatch, not a review
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

import { readStamps } from './review-stamp.mjs';

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
 *   4  0.3.29 — the host's dispatch record decides `finalReview` where it can;
 *      prose is the fallback and is graded `inferred`
 *   5  this change: a dispatch stamp written by `forge review-label` at dispatch
 *      time decides `finalReview` (`recorded`) when the host cannot answer;
 *      prose remains the last fallback
 *
 * Rule 4 is the first that is not a prose rule at all on its primary path, so a
 * rule-3 `independent` and a rule-4 `independent` are not the same measurement
 * and `fleet-report` must keep refusing to add them. Rule 5 widens that: its
 * `independent` can now come from three different records, and the stamp's is
 * one no earlier rule could see — a session graded `self` under rule 4 because
 * its host transcript had been pruned would be `independent` under rule 5 on
 * the same bytes.
 */
export const CENSUS_RULE = 5;

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
 * The requests one dispatch must have made before it can certify a review.
 *
 * MEASURED, NOT PICKED. `readReviewerSidecars` over all 24 `forge-review`
 * dispatches on this machine (2026-07-30): minimum 15 requests, median 55,
 * maximum 173, none below 15. The forged dispatch that prompted this made 1.
 * Five sits well under the observed minimum and well over the forgery, so it
 * separates them without sitting near either. The figures are in
 * `specs/changes/review-dispatch-substance/design.md`.
 *
 * RE-MEASURE AGAINST A REAL CORPUS BEFORE MOVING IT — real reviews and token
 * ones both, before the change ships and not after it has graded a session.
 * That rule is F11, still open, and it was filed because 0.3.24 tightened a
 * classifier in front of this gate on a number nobody had measured: 0.3.26
 * reverted it, and what it cost in between was correct work refused. Raising
 * this is the direction that starts refusing short reviews of small changes.
 *
 * Not a security boundary, and not claimed as one: a forger who reads this can
 * pad to five. It ends the one-line forgery — the cost of faking a review
 * becomes a subagent that genuinely runs — and F12's stamp written at dispatch
 * time is still the real fix.
 */
export const FINAL_REVIEW_REQUEST_FLOOR = 5;

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
 *   `null` means "the host cannot answer" and never "no reviewer ran" — the
 *   fourth way to reach it is a dispatch below `FINAL_REVIEW_REQUEST_FLOOR`,
 *   at the end of this function
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
  // all three counts on every bucket it creates, so a bucket missing any of
  // them is not its output — and 3.2 round-trips this through JSON, where the
  // shape stops being ours. Falls back to prose, the side that cannot refuse
  // correct work.
  //
  // `maxRequests` IS ONE OF THE THREE, and it is the one that had to be added:
  // every bucket built before the floor existed carries the other two and
  // not it, and `undefined < FINAL_REVIEW_REQUEST_FLOOR` is `false`, so such a
  // bucket sailed past the floor and graded `independent`. Reading a missing
  // measurement as "large enough" is this module's own collapse run backwards.
  // Checked here rather than beside the floor so it is read before the stop is:
  // answering `self` off two fields of a bucket whose third says it is not ours
  // is still deciding on a shape we cannot vouch for, and the answer it would
  // give is the one that refuses at the gate.
  if (
    typeof bucket !== 'object' ||
    bucket === null ||
    Array.isArray(bucket) ||
    typeof bucket.dispatched !== 'number' ||
    typeof bucket.stopped !== 'number' ||
    typeof bucket.maxRequests !== 'number'
  ) {
    return null;
  }
  // THE `self` BRANCH IS EXEMPT FROM THE FLOOR BELOW, and that is not an
  // oversight. A unit whose every dispatch was stopped is `self` because the
  // operator declined the reviewer — a decision the host recorded, which this
  // module is required to report and the prose has no standing to overturn.
  // Routing it to prose on a low request count would let a review file the
  // operator's own refusal contradicts answer `independent` instead. Substance
  // is a question about a reviewer that ran; nothing here ran.
  if (bucket.stopped >= bucket.dispatched) {
    return { finalReview: 'self', stoppedByOperator: bucket.stopped > 0 };
  }
  // A DISPATCH IS NOT A REVIEW. Reaching here means a dispatch the operator did
  // not stop exists, which is all this function used to ask: a throwaway
  // subagent labelled `forge-review final <sessionId>` — one request, reading
  // nothing — certified the review and passed the money/auth gate against a
  // file that said no subagent had read the change (F33). So the busiest single
  // unstopped dispatch must also look like work. `maxRequests`, never
  // `requests`: the sum is assembled out of dispatches that each reviewed
  // nothing, and it counts stopped ones, so a long dispatch the operator killed
  // would vouch for a token one beside it. Some ONE dispatch has to have done
  // the work.
  //
  // BELOW THE FLOOR THE ANSWER IS `null` — "the host cannot say" — AND NEVER
  // `self`. `self` here would refuse a transition at the money/auth gate on a
  // request count, and a genuine reviewer whose transcript was pruned reports
  // zero requests: this module would then be refusing correct work on an
  // absence, the failure it has now been reverted for twice. Prose is the side
  // of this call that can only cost a grade. It grades `inferred`, and the
  // forged session's own review file is what then decides it.
  if (bucket.maxRequests < FINAL_REVIEW_REQUEST_FLOOR) return null;
  return { finalReview: 'independent', stoppedByOperator: bucket.stopped > 0 };
}

/**
 * Whether this session recorded dispatching a final reviewer.
 *
 * THE STAMP SUBSTITUTES FOR A RECORD THE HOST LOST, NEVER FOR WORK THE REVIEWER
 * DIDN'T DO. `forge review-label` writes one stamp into
 * `reviews/dispatches.json` when it prints the label a reviewer subagent is to
 * be dispatched with — before any subagent exists, and whether or not one
 * follows. So this answers "a reviewer was sent", not "a reviewer ran": the
 * gap is deliberate and is exactly why `recorded` ranks below `host`, which
 * measures the dispatch itself. What it recovers is the session whose host
 * transcript was later pruned, where the host cannot answer and the prose then
 * decides by reading the file written by the party being judged. The doctrine
 * is also the limit: `hostFinalReview` answering `null` because it *measured*
 * the dispatch and found no work is a different state, and
 * `finalBucketWellFormed` below keeps the stamp out of it.
 *
 * TWO CONDITIONS, BOTH LOAD-BEARING. `unit` is the module's existing scope
 * boundary — a per-group reviewer says nothing about who read the change as a
 * whole, exactly as on the host path. It is compared LOWER-CASED because the
 * writer does not normalise it: `review-label`'s unit charset is
 * case-insensitive and only the printed label is lower-cased, so
 * `forge review-label Final` stores `"unit": "Final"`. A case-sensitive
 * comparison discarded that genuine stamp and handed the gate back to the
 * judged party's file — the unsafe direction, off a capital letter.
 * `reviewEvidence` lower-cases the unit it captures for the same reason (see
 * `FINAL_REVIEW_UNIT`); this is the comparison that had drifted out of step.
 * `sessionId` is the copy guard: this file sits inside the session directory
 * and travels with it, so a stamp naming another session would let one
 * dispatched reviewer certify every copy of the directory it ran in. The
 * session directory's name IS the session id.
 *
 * `readStamps` returns `[]` for a missing, unreadable, malformed or
 * wrong-shaped file and never throws, so every failure here reads as "no stamp"
 * and falls through to prose — the side of this call that cannot refuse correct
 * work, the same discipline the rest of this module is built on.
 *
 * @param {string} sessionDir
 * @returns {boolean}
 */
function stampedFinalReview(sessionDir) {
  const sessionId = path.basename(sessionDir);
  return readStamps(sessionDir).some(
    (stamp) =>
      String(stamp.unit).toLowerCase() === FINAL_REVIEW_UNIT && stamp.sessionId === sessionId,
  );
}

/**
 * Whether the host's answer carries a `final` bucket the host could read whole.
 *
 * THE ONE `null` THE HOST MEASURED. `hostFinalReview` returns `null` for five
 * different reasons and only one of them is a measurement: a well-formed `final`
 * bucket whose busiest unstopped dispatch is below `FINAL_REVIEW_REQUEST_FLOOR`.
 * The others are all the host unable to look — no answer, unreadable tallies, a
 * convention not in use (whose `units` is empty, because buckets are built only
 * from prescribed records), a unit missing from the table, a bucket whose counts
 * are junk. So "the evidence has a well-formed `final` bucket" isolates the
 * below-floor branch exactly, without `hostFinalReview` having to grow a second
 * return channel — its contract and its tests stand.
 *
 * The shape checked here MIRRORS that function's own bucket validation and must
 * keep mirroring it: widening one without the other either lets the stamp answer
 * on the branch this guard exists to close, or blocks it on a `null` the host
 * never measured.
 *
 * @param {unknown} evidence the object `reviewEvidence` returns
 * @returns {boolean}
 */
function finalBucketWellFormed(evidence) {
  if (!evidence || typeof evidence !== 'object') return false;
  const { available, units, seen, prescribed } = /** @type {any} */ (evidence);
  if (available !== true) return false;
  if (typeof seen !== 'number' || typeof prescribed !== 'number') return false;
  if (!units || typeof units !== 'object') return false;
  const bucket = units[FINAL_REVIEW_UNIT];
  return (
    typeof bucket === 'object' &&
    bucket !== null &&
    !Array.isArray(bucket) &&
    typeof bucket.dispatched === 'number' &&
    typeof bucket.stopped === 'number' &&
    typeof bucket.maxRequests === 'number'
  );
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
 *   `metrics/review-evidence.mjs`'s `reviewEvidence` returns. Omitted — as most
 *   callers still omit it (`score.mjs`, `ledger.mjs`; `set-phase.mjs`'s
 *   `freezeReviewVerdict` passes it) — the verdict falls to this session's own
 *   dispatch stamp, graded `recorded`, and then to the prose reading this
 *   module has always done, graded `inferred`. No caller wiring is needed for
 *   the stamp: it lives under `sessionDir`, which every caller already passes.
 * @returns {{ total: number, independent: number, selfChecks: number,
 *   rejections: number, finalReview: 'independent' | 'self' | null,
 *   finalReviewEvidence: 'host' | 'recorded' | 'inferred' | 'none',
 *   stoppedByOperator: boolean, rule: number }} `finalReviewEvidence` grades
 *   `finalReview` only, strongest first: `host` — measured from the host's own
 *   dispatch record; `recorded` — a dispatch stamp `forge review-label` wrote
 *   into `reviews/dispatches.json` when it labelled the reviewer, read back
 *   here by `readStamps`; `inferred` — read off the review file's prose;
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
    } else if (!finalBucketWellFormed(options?.evidence) && stampedFinalReview(sessionDir)) {
      // THE STAMP SUBSTITUTES FOR A RECORD THE HOST LOST, NEVER FOR WORK THE
      // REVIEWER DIDN'T DO. Reaching here means the host could not answer, and
      // the session nonetheless recorded labelling a final reviewer for
      // dispatch at the time it did so — the pruned-transcript session whose
      // reviewer rule 4 erased.
      //
      // THE SECOND HALF OF THAT SENTENCE IS `finalBucketWellFormed`, and it is
      // the whole of the guard. A `null` off a well-formed `final` bucket is the
      // one `null` the host *measured*: a dispatch nobody stopped that made
      // fewer than `FINAL_REVIEW_REQUEST_FLOOR` requests, which
      // review-dispatch-substance routed to the prose precisely because a
      // one-request subagent labelled `forge-review final <sessionId>` had
      // certified a review and passed the money/auth gate (F33). The forger runs
      // `forge review-label` too — that command is where the label came from —
      // so a stamp answering here would hand that forgery its `independent`
      // back, off a record written before the token dispatch even existed.
      //
      // A MALFORMED BUCKET IS NOT A MEASUREMENT, so the stamp does answer there,
      // and that is not a contradiction of the block in `hostFinalReview` that
      // refuses to read the same shape. Two different questions: the host
      // declining to answer `self` off a bucket it cannot vouch for protects
      // against refusing correct work at the gate; the stamp declining to
      // certify a dispatch the host measured as empty protects against
      // certifying work nobody did. Same doctrine, opposite shapes, because
      // over-credit is this module's chosen error direction everywhere except
      // where the host has already looked and found nothing.
      //
      // `body` IS UNTOUCHED, for the same reason as on the host path above, and
      // the test that pins it is the one with NEUTRAL prose: a fixture whose
      // prose says `self-check` cannot tell this branch apart from one that
      // reads the prose and consults the stamp only to break a `self` tie —
      // both answer `independent`. Only the grade separates them, so the pin
      // asserts `recorded` on a file the prose rule alone would already have
      // called independent. A task reviewer shipped exactly that tiebreak
      // mutant against the earlier tests and the whole suite stayed green.
      census.finalReview = 'independent';
      census.finalReviewEvidence = 'recorded';
    } else {
      census.finalReview = SELF_REVIEW_RE.test(attributionRegion(body)) ? 'self' : 'independent';
      census.finalReviewEvidence = 'inferred';
    }
    if (REJECTION_RE.test(body)) census.rejections += 1;
    break;
  }
  return census;
}
