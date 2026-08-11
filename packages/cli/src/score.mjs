/**
 * Forge session scorecard — L2 measurement after (or before) phase done.
 *
 * Grades session *artifacts*, not the agent's self-report. L1 integrity is a
 * prerequisite signal inside the score; L3 golden/product outcomes stay
 * human/CI. See docs/usage.md § Session success.
 */

import fs from 'node:fs';
import path from 'node:path';
import { hasBlockedMarker, readJson, writeJson } from './lib.mjs';
import { loadAllowances } from './guard.mjs';
import {
  JOBS_SIGNAL_RE,
  checkE2eGate,
  e2eDisabledReason,
  e2ePath,
  loadDeferrals,
  openDeferrals,
  readTddRunStamps,
  resolveChangeDir,
  runIntegrityChecks,
  sessionJobsSignalText,
  spinePath,
  validateSpine,
} from './integrity.mjs';
import { sessionHealth } from './health.mjs';
import { collectPlanFacts } from './plan-facts.mjs';
import { isHighRiskText, resolveEffectivePreferences } from './preferences.mjs';
import { reviewCensus } from './review-census.mjs';
import { reviewEvidence } from './metrics/review-evidence.mjs';
import { frozenReviewVerdict } from './review-verdict.mjs';
import { appendDeferralLedger, appendSessionDigest } from './ledger.mjs';

/** Keep in sync with set-phase.mjs TASK_COUNT_ESCALATION_THRESHOLD. */
const TASK_COUNT_ESCALATION_THRESHOLD = 15;

/** Ceiling (grade C) for sessions whose outcome is unproven or unreviewed. */
const OUTCOME_CAP = 69;

/**
 * Structured scorecard cap (F14). Legacy ledger lines may still be plain strings.
 * @typedef {{ id: string, applied: boolean, before: number | null, after: number | null, text: string }} CapEntry
 */

/**
 * Render text for a cap entry (structured object or legacy string).
 * @param {CapEntry | string | null | undefined} c
 */
export function capText(c) {
  return typeof c === 'string' ? c : (c?.text ?? '');
}

/**
 * Whether a cap entry counts as an applied reduction. Legacy strings fail closed
 * (treated as applied) — historical lines almost always meant a real cap.
 * @param {CapEntry | string | null | undefined} c
 */
export function capIsApplied(c) {
  return typeof c === 'string' || c?.applied === true;
}

/**
 * @param {unknown} value
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * @param {number} score
 */
export function gradeForScore(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

/**
 * A `group-NN-*` dir that holds only the group's review — a review, not a unit
 * of work that needs one. Detected by content, not by name, so a batch dir that
 * also carries a group review still counts as work.
 *
 * @param {string} dir
 */
function isReviewContainer(dir) {
  return (
    fs.existsSync(path.join(dir, 'group-review.md')) &&
    !fs.existsSync(path.join(dir, 'test-evidence.md')) &&
    !fs.existsSync(path.join(dir, 'brief.md'))
  );
}

/**
 * Whether a task dir's `tdd-runs.jsonl` carries at least one `ok: true`
 * pass-stamp — a task whose only evidence was produced by `forge tdd run`
 * (never `forge evidence`) still demonstrated a real green run. Reuses
 * `integrity.mjs`'s `readTddRunStamps`, the same fail-closed parser
 * `checkTddEvidence` uses, so a malformed or unreadable ledger here reads as
 * "no stamp" rather than crashing the scorecard or silently over-crediting.
 *
 * DELIBERATE DIVERGENCE FROM `checkTddEvidence`: this credits a *pass-only*
 * ledger (a green stamp with no preceding red), which is exactly the shape
 * `checkTddEvidence` refuses at the `forge phase done` gate — that check
 * requires an ok fail-stamp chronologically before the ok pass-stamp, this
 * one does not. That is what the capability spec asks for ("Executed stamps
 * count as tier-2 evidence for scoring", scenario: "the only evidence is a
 * valid red→green tdd-runs.jsonl" — pairing already assumed there), but it
 * means the scorer is more permissive than the done gate on this one shape:
 * a task with only a pass-stamp still fails `forge phase done` (as it
 * should) while separately scoring as tier-2-covered here. Keep this
 * divergence intentional, not accidental, if either side changes.
 *
 * @param {string} dir task dir (e.g. `<sessionDir>/tasks/01-thing`)
 * @returns {boolean}
 */
function hasOkPassStamp(dir) {
  const file = path.join(dir, 'tdd-runs.jsonl');
  if (!fs.existsSync(file)) return false;
  const { stamps, error } = readTddRunStamps(file);
  if (error) return false;
  return stamps.some((s) => s.expect === 'pass' && s.ok === true);
}

/**
 * @param {string} sessionDir
 */
function listTaskEvidence(sessionDir) {
  const tasksDir = path.join(sessionDir, 'tasks');
  if (!fs.existsSync(tasksDir)) return { taskDirs: 0, withEvidence: 0, exitNonZero: 0 };
  // `tasks/` holds implementer batches *and* the `group-NN-*` dirs their group
  // reviews live in. Counting a review as a unit of work needing evidence
  // punished a session twice for doing group reviews: the evidence ratio fell
  // because a review folder carries no test-evidence.md, and review coverage
  // was measured against an inflated denominator.
  const entries = fs
    .readdirSync(tasksDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => !isReviewContainer(path.join(tasksDir, e.name)));
  let withEvidence = 0;
  let exitNonZero = 0;
  for (const e of entries) {
    const dir = path.join(tasksDir, e.name);
    const file = path.join(dir, 'test-evidence.md');
    if (!fs.existsSync(file)) {
      // No test-evidence.md — a task scored purely by `forge tdd run` still
      // counts, so a red→green-only task isn't reported as missing evidence.
      if (hasOkPassStamp(dir)) withEvidence += 1;
      continue;
    }
    withEvidence += 1;
    const body = fs.readFileSync(file, 'utf8');
    const m = body.match(/\*\*Exit code:\*\*\s*`?(-?\d+)`?/i) || body.match(/Exit code:\s*`?(-?\d+)`?/i);
    if (m && Number(m[1]) !== 0) exitNonZero += 1;
    // Ceremony-only heuristic
    if (
      /\bstatus\s*===?\s*['"]?succeeded['"]?/i.test(body) &&
      !/\b(assert|expect|differ|baseline|parquet|proposal|ingestion_stats)\b/i.test(body)
    ) {
      // counted in evidenceHonesty separately via scanning all files
    }
  }
  return { taskDirs: entries.length, withEvidence, exitNonZero };
}

/**
 * TRADE-OFF SURFACED BY REVIEW: this only ever reads `test-evidence.md` —
 * there is no equivalent ceremony-only scan of `tdd-runs.jsonl`. Since task
 * 5.3, a task dir can carry full tier-2 coverage (`listTaskEvidence` /
 * `hasOkPassStamp` above) from a red→green ledger alone, with no
 * `test-evidence.md` at all — such a task passes through this honesty check
 * entirely unscrutinised, neither penalised nor flagged. This is defensible
 * (a `tdd-runs.jsonl` stamp is a command the CLI actually executed and
 * recorded the exit code for, unlike free-text prose, so there is no
 * "ceremony" for this heuristic to catch), but it is a real gap in coverage
 * and not merely an oversight — write it down so a future change to either
 * side does so deliberately.
 *
 * @param {string} sessionDir
 */
function evidenceHonestyIssues(sessionDir) {
  /** @type {string[]} */
  const issues = [];
  const tasksDir = path.join(sessionDir, 'tasks');
  if (!fs.existsSync(tasksDir)) return issues;
  for (const e of fs.readdirSync(tasksDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const file = path.join(tasksDir, e.name, 'test-evidence.md');
    if (!fs.existsSync(file)) continue;
    const body = fs.readFileSync(file, 'utf8');
    const ceremonyOnly =
      /\b(succeeded|job status|handler (was )?called|claim|lease)\b/i.test(body) &&
      !/\b(assert|expect|differ|baseline|parquet|proposal|ingestion|fixture|side.?effect)\b/i.test(body);
    if (ceremonyOnly) {
      issues.push(`${e.name}: tier-2 evidence looks ceremony-only (status/claim without domain asserts)`);
    }
  }
  return issues;
}

/**
 * Reads `guard-allowances.json` for the scorecard (spec: "Allowances are
 * recorded, reasoned, and surfaced" — SHALL be listed in the scorecard, not
 * only reviewer-packet context). Reuses `guard.mjs`'s `loadAllowances` — the
 * one reader the hook and the integrity backstop already trust — rather than
 * a second parser that could disagree with them about what an allowance is.
 *
 * Fails closed like every other malformed-artifact read in this file (spine,
 * `tdd-runs.jsonl`): an unreadable ledger surfaces as `error`, an empty list
 * never as a crash and never silently as "no allowances".
 *
 * @param {string} sessionDir
 * @returns {{ allowances: Array<{ path: string, reason: string, at: string, phase: string | null }>, error: string | null }}
 */
function loadAllowancesForScorecard(sessionDir) {
  try {
    return { allowances: loadAllowances(sessionDir), error: null };
  } catch (err) {
    return { allowances: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * True when a green e2e run was executed against the current e2e.json — the
 * primary product-loop signal: score what ran, not what was written. A phrase
 * match in verify-evidence is only the fallback (a session that titled its
 * section differently but ran the loop green must not score 0).
 *
 * @param {{ cwd?: string, session?: Record<string, unknown> | null, sessionDir: string }} opts
 */
function e2eRunGreen(opts) {
  try {
    const e2eFile = e2ePath(opts);
    const gate = checkE2eGate({ e2eFile, sessionDir: opts.sessionDir });
    return gate.problems.length === 0 && !gate.notApplicable;
  } catch {
    return false;
  }
}

/**
 * @param {string} body
 * @param {boolean} executedGreen
 */
function scoreProductLoopBody(body, executedGreen = false) {
  /** @type {string[]} */
  const notes = [];
  let pts = 0;
  const max = 20;
  if (hasBlockedMarker(body)) {
    notes.push('verify-evidence contains BLOCKED — product-loop not proven');
    return { points: 0, max, notes };
  }
  if (executedGreen) {
    pts += 8;
    notes.push('green e2e run executed against current e2e.json — loop proven by execution');
  } else if (/product[- ]loop/i.test(body)) {
    pts += 8;
    notes.push('product-loop section present (phrase-based — no executed green e2e run)');
  } else {
    notes.push('no executed green e2e run and no product-loop section in verify-evidence');
    return { points: 0, max, notes };
  }
  // \w* suffixes: a trailing \b silently rejected inflected forms ("asserts",
  // "fixtures", "ratify") and cost honest sessions real points.
  if (/\b(fixture\w*|OP\d+|testdata\w*|sample\w*)/i.test(body)) {
    pts += 4;
    notes.push('names a fixture / corpus');
  }
  if (/\b(differ\w*|baseline\w*|ratif\w*|assert\w*|before.?after|output changed)/i.test(body)) {
    pts += 5;
    notes.push('asserts decision/output change vs baseline');
  } else {
    notes.push('missing baseline-diff / ratify-changes-output assertion');
  }
  if (/\b(1\.|2\.|step)\b/i.test(body) || body.split('\n').filter((l) => /^\s*\d+\./.test(l)).length >= 2) {
    pts += 3;
    notes.push('multi-step loop listed');
  }
  return { points: Math.min(pts, max), max, notes };
}

/**
 * Cap the score when the effective `review.perTask` knob prescribed per-group
 * reviewers and none showed up — F13 (specs/changes/review-coverage-cap).
 * Review depth is worth 5 of ~100 points, too little to ever move a grade on
 * its own; three sessions in this project's own recorded history that
 * dispatched no reviewer at all scored 94/A, 97/A and 90/A.
 *
 * GATES ON THE KNOB, NOT THE PACE. `review.perTask` is an independently
 * overridable knob (preferences.mjs) — `forge prefs -- --set
 * review.perTask=never` sets it regardless of pace. This cap originally
 * gated on `resolvedPace` being `thorough`/`standard` directly, so a
 * `standard`-pace session correctly told (via the knob) to skip per-group
 * reviewers was still capped 69/C, with a message asserting reviewers were
 * prescribed — punishing the exact obedience this cap exists to reward, the
 * same failure class 0.3.24 shipped and 0.3.26 reverted, reached through the
 * knob instead of the pace. The four paces still map onto these knob values
 * 1:1 (thorough->always, standard->per-group, brisk->never,
 * lite->never — preferences.defaults.json's presets), so gating on the knob
 * subsumes the old pace gate for any session that never touched the knob,
 * rather than changing behaviour for it.
 *
 * PURE. `perTaskReview` arrives pre-resolved as a parameter — this function
 * does no preferences/filesystem access itself and shares no mutable state
 * with the scoring path, so there is no branch here for a defect like
 * 0.3.25's to hide in. `scoreSession` resolves the effective knob via
 * `resolveEffectivePreferences` and fails safe (does not cap) if that
 * resolution throws or returns something unusable.
 *
 * DRIVEN BY `census.independent` DIRECTLY, and only that field, never by a
 * variable a no-review code path could leave unassigned. 0.3.25 (reverted in
 * 0.3.26) shipped this cap reading `reviewUnits`, a variable assigned only
 * inside the has-at-least-one-review branch: a session with zero reviews kept
 * `reviewUnits = 0`, failed the guard, and scored uncapped — while a session
 * with one thin review met the guard and was capped. The exact session the
 * cap existed to catch was the one it could never see. `census.independent`
 * has no such branch to skip: `reviewCensus` initialises it to 0 at
 * construction and returns it on every path (review-census.mjs), including
 * the one where no review files exist at all.
 *
 * NO GROUP DENOMINATOR. Both tiers ask only whether `independent` is zero,
 * never a coverage *ratio* against a task-group count: that denominator has
 * its own open defects (finding F16) and this cap is built not to depend on
 * them.
 *
 * A MALFORMED CENSUS DOES NOT CAP. `independent` missing, or not a finite
 * number, reads as "cannot tell" and returns `null` — never as zero. Reading
 * an absence as zero would cap a session on missing data, the same failure
 * direction this subsystem has been reverted for twice, just moved one field
 * over.
 *
 * @param {{ census: { independent?: unknown, finalReview?: unknown } | null | undefined,
 *   perTaskReview: unknown, tasks: unknown }} args
 * @returns {{ cap: number, reason: string } | null}
 */
export function reviewCoverageCap({ census, perTaskReview, tasks }) {
  // Only `always` and `per-group` prescribe per-group reviewers.
  // `high-risk-only` and `never` never do, whatever the pace; anything else
  // (missing, unrecognised) is "cannot tell" and must not cap — same
  // fail-safe direction as the malformed-census guard below.
  if (perTaskReview !== 'always' && perTaskReview !== 'per-group') return null;
  if (typeof tasks !== 'number' || tasks < 5) return null;
  if (!census || typeof census !== 'object') return null;
  const independent = census.independent;
  if (typeof independent !== 'number' || !Number.isFinite(independent)) return null;
  if (independent > 0) return null;
  if (census.finalReview === 'independent') {
    // 89, NOT 79, AND THE DIFFERENCE IS THE WHOLE POINT OF THIS TIER. Grade
    // bands (`gradeForScore`) put B at >= 80, so a 79 ceiling lands in C —
    // the same grade as the harsh tier above it. This shipped as 79 in
    // development, said "softened to a B" in its own message, and was caught
    // only by replaying the corpus and reading the *grades* rather than the
    // scores: every test asserted the number and none asserted the band. A
    // tier whose softening is invisible in the grade is the exact complaint
    // F13 was filed about — review depth that cannot move a grade.
    return {
      cap: 89,
      reason: 'no per-group reviewers were dispatched, though an independent final review exists — cap softened to a B',
    };
  }
  return {
    cap: 69,
    reason: 'no per-group reviewers were dispatched — nobody outside the author read this as it was built',
  };
}

/**
 * Score an active Forge session from on-disk artifacts.
 *
 * @param {{ cwd?: string, sessionDir: string, session: Record<string, unknown> }} opts
 */
export function scoreSession(opts) {
  const cwd = opts.cwd ?? process.cwd();
  const { sessionDir, session } = opts;
  /** @type {{ id: string, label: string, points: number, max: number, notes: string[] }[]} */
  const checks = [];
  /** @type {string[]} */
  const humanPrompts = [
    'Can you name the production path for the main REQ? (job / endpoint / CLI)',
    'If you exercise that path (fixture upload / API), does the UI show real data — not empty queues?',
    'If governance was in scope: does ratify change the next run’s output?',
    'Would you ship this to a customer tomorrow? (yes / no / only with a follow-on change)',
  ];

  // --- integrity (20) ---
  const integrity = runIntegrityChecks({ cwd, sessionDir, session });
  checks.push({
    id: 'integrity',
    label: 'L1 integrity gate (spine / deferrals / product-loop presence)',
    points: integrity.ok ? 20 : 0,
    max: 20,
    notes: integrity.ok ? ['integrity-check would pass'] : integrity.problems.slice(0, 8),
  });

  // --- spine quality (25) ---
  let spinePts = 0;
  const spineMax = 25;
  /** @type {string[]} */
  const spineNotes = [];
  const spineFile = spinePath({ cwd, session, sessionDir });
  // What the change actually touches, for risk detection below — a slug
  // written at session start rarely says "auth" even when the change is one.
  let spineText = '';
  if (!fs.existsSync(spineFile)) {
    spineNotes.push('spine.json missing');
  } else {
    try {
      const doc = readJson(spineFile);
      spineText = JSON.stringify(doc);
      const v = validateSpine(doc);
      if (!v.ok) {
        spineNotes.push(...v.problems);
      } else if (isNonEmptyString(doc.notApplicable)) {
        spinePts = 25;
        spineNotes.push(`notApplicable: ${doc.notApplicable}`);
      } else {
        const rows = Array.isArray(doc.rows) ? doc.rows : [];
        spinePts = 25;
        spineNotes.push(`${rows.length} wired row(s)`);
        const weak = rows.filter(
          (r) =>
            r &&
            typeof r === 'object' &&
            (!isNonEmptyString(/** @type {Record<string, unknown>} */ (r).runtimeOwner) ||
              !isNonEmptyString(/** @type {Record<string, unknown>} */ (r).writes)),
        );
        if (weak.length) {
          spinePts = Math.max(5, spinePts - weak.length * 5);
          spineNotes.push(`${weak.length} row(s) look library-weak`);
        }
      }
    } catch (err) {
      spineNotes.push(`unreadable: ${err instanceof Error ? err.message : err}`);
    }
  }
  checks.push({ id: 'spine', label: 'Spine matrix quality', points: spinePts, max: spineMax, notes: spineNotes });

  // --- product loop (20) ---
  const evidenceFile = path.join(sessionDir, 'verify-evidence.md');
  let loopPts = 0;
  const loopMax = 20;
  /** @type {string[]} */
  let loopNotes = [];
  let spineHasRows = false;
  let spineNotApplicable = false;
  if (fs.existsSync(spineFile)) {
    try {
      const doc = readJson(spineFile);
      spineNotApplicable = isNonEmptyString(doc.notApplicable);
      spineHasRows =
        Array.isArray(doc.rows) && doc.rows.length > 0 && !spineNotApplicable;
    } catch {
      // ignore
    }
  }
  if (spineNotApplicable) {
    loopPts = 20;
    loopNotes = ['sync/docs notApplicable — product-loop N/A (full credit)'];
  } else if (!fs.existsSync(evidenceFile)) {
    loopNotes = ['verify-evidence.md missing'];
  } else {
    const body = fs.readFileSync(evidenceFile, 'utf8');
    const e2eOff = e2eDisabledReason(cwd);
    const executedGreen = !e2eOff && e2eRunGreen({ cwd, session, sessionDir });
    if (spineHasRows || JOBS_SIGNAL_RE.test(sessionJobsSignalText(session))) {
      const scored = scoreProductLoopBody(body, executedGreen);
      loopPts = scored.points;
      loopNotes = scored.notes;
    } else {
      // Rows expected but maybe empty invalid spine — still look for loop
      if (executedGreen || /product[- ]loop/i.test(body)) {
        const scored = scoreProductLoopBody(body, executedGreen);
        loopPts = scored.points;
        loopNotes = scored.notes;
      } else {
        loopPts = 10;
        loopNotes = ['no spine rows and no jobs signal — partial credit without product-loop'];
      }
    }
    if (e2eOff) {
      loopNotes.push(`e2e disabled by project config ("${e2eOff}") — scored from evidence text only`);
    }
  }
  checks.push({
    id: 'product_loop',
    label: 'Product-loop evidence quality',
    points: loopPts,
    max: loopMax,
    notes: loopNotes,
  });

  // --- deferrals (10) ---
  const deferrals = loadDeferrals(sessionDir).deferrals;
  const open = openDeferrals(sessionDir);
  let deferPts = 10;
  /** @type {string[]} */
  const deferNotes = [];
  if (open.length > 0) {
    deferPts = 0;
    deferNotes.push(`unresolved: ${open.map((d) => d.task).join(', ')}`);
  } else if (deferrals.length === 0) {
    deferNotes.push('no deferrals registered');
  } else {
    deferNotes.push(`${deferrals.length} deferral(s), all resolved`);
  }
  checks.push({
    id: 'deferrals',
    label: 'Deferral hygiene',
    points: deferPts,
    max: 10,
    notes: deferNotes,
  });

  // --- tasks + evidence (10) ---
  const total = Number(session.tasksTotal) || 0;
  const complete = Number(session.tasksComplete) || 0;
  const ev = listTaskEvidence(sessionDir);
  let taskPts = 0;
  /** @type {string[]} */
  const taskNotes = [];
  if (total === 0) {
    taskPts = 5;
    taskNotes.push('tasksTotal=0 — partial credit');
  } else if (complete >= total) {
    taskPts = 6;
    taskNotes.push(`tasks ${complete}/${total} complete`);
  } else {
    taskPts = Math.round((complete / total) * 6);
    taskNotes.push(`tasks incomplete ${complete}/${total}`);
  }
  if (ev.taskDirs === 0) {
    taskNotes.push('no task dirs yet');
  } else {
    const ratio = ev.withEvidence / ev.taskDirs;
    taskPts += Math.round(ratio * 4);
    taskNotes.push(`tier-2 evidence in ${ev.withEvidence}/${ev.taskDirs} task dirs`);
    if (ev.exitNonZero) {
      taskPts = Math.max(0, taskPts - ev.exitNonZero);
      taskNotes.push(`${ev.exitNonZero} evidence file(s) with non-zero exit`);
    }
  }
  taskPts = Math.min(10, taskPts);
  checks.push({
    id: 'tasks',
    label: 'Task completion + tier-2 evidence coverage',
    points: taskPts,
    max: 10,
    notes: taskNotes,
  });

  // --- evidence honesty (5) ---
  const honestyIssues = evidenceHonestyIssues(sessionDir);
  const honestyPts = honestyIssues.length === 0 ? 5 : Math.max(0, 5 - honestyIssues.length * 2);
  checks.push({
    id: 'evidence_honesty',
    label: 'Evidence honesty (not ceremony-only)',
    points: honestyPts,
    max: 5,
    notes: honestyIssues.length ? honestyIssues.slice(0, 5) : ['no ceremony-only heuristics fired'],
  });

  // --- pace sanity (5) ---
  let pacePts = 5;
  /** @type {string[]} */
  const paceNotes = [];
  const resolved = session.resolvedPace;
  if (
    (resolved === 'brisk' || resolved === 'lite') &&
    total >= TASK_COUNT_ESCALATION_THRESHOLD &&
    session.paceEscalated !== true &&
    session.paceDeescalated !== true &&
    session.pacePinned !== true
  ) {
    pacePts = 0;
    paceNotes.push(
      `resolvedPace=${resolved} with ${total} tasks — expected escalation to standard`,
    );
  } else if (session.paceEscalated) {
    paceNotes.push(`escalated: ${session.paceReason ?? 'task count'}`);
  } else if (session.paceDeescalated) {
    // Decide from the recorded marker, not from whether brisk/lite +
    // tasksTotal>=15 happen to coincide today — `session.tasksTotal`
    // (coordinator-declared) and the plan's own task count can legitimately
    // disagree and drift apart after this pace was resolved (`forge status`
    // heals `tasksTotal` straight from tasks.md, mid-session, without
    // re-running the escalation check above), so a plan-lowered pace must
    // never read as a missed escalation just because tasksTotal grew later.
    paceNotes.push(`de-escalated: ${session.paceReason ?? 'plan facts'}`);
  } else {
    paceNotes.push(`resolvedPace=${resolved ?? 'unset'}`);
  }
  checks.push({ id: 'pace', label: 'Pace sanity', points: pacePts, max: 5, notes: paceNotes });

  // Read once and reused by the review-coverage denominator and the risk cap
  // below — the gate reads the same facts, and two readings would drift.
  let planFacts = null;
  try {
    planFacts = collectPlanFacts({ cwd, session });
  } catch {
    /* an unreadable plan must not break scoring */
  }

  // --- review depth (5) — scored by what was dispatched ---
  // ONE CENSUS, TWO CONSUMERS. Review depth below and the high-risk cap further
  // down both read `finalReview`, and the cap has to agree with the done gate:
  // a session the gate refuses and the scorecard then scores uncapped leaves
  // the record that outlives cleanup silent about the missing review. That
  // happened once already, in 0.3.22, for a different reason.
  //
  // `finalReview` comes from the verdict `set-phase.mjs` measured from the
  // host's dispatch record and froze onto the session at the transition — the
  // same value the gate read. Not re-measured: the evidence expires, and this
  // function also runs from `forge score` long after the fact. A session with
  // no frozen verdict — anything that finished before this change, or a
  // scorecard taken mid-session — falls back to a live census that consults
  // host evidence the same way the freeze does (F63), so a stamp alone cannot
  // outrank a measured stop. The per-group counts stay on prose by design.
  const evidence = reviewEvidence({ session, env: process.env });
  const live = reviewCensus(sessionDir, { evidence });
  const frozen = frozenReviewVerdict(session);
  const census = frozen
    ? {
        ...live,
        finalReview: frozen.final,
        finalReviewEvidence: frozen.evidence,
        stoppedByOperator: frozen.stoppedByOperator,
      }
    : live;
  let reviewPts = 0;
  /** @type {string[]} */
  const reviewNotes = [];
  if (census.total === 0 && !census.finalReview) {
    reviewNotes.push('no review artifacts at all — nobody read this work but the author');
  } else {
    // Coverage, not presence: one review across eight task groups is not the
    // same signal as nine across nine. The denominator is the tasks.md group —
    // the unit one `per-group` review actually covers — falling back to task
    // dirs only when there is no readable plan to count.
    // `pace.md`: a tasks.md with no `##` headings is ONE group, reviewed once
    // when all tasks are done. Falling through to the batch count for that
    // shape reported "1 of 6" for a plan the skill explicitly endorses.
    const groups = planFacts?.readable
      ? Math.max(planFacts.groups, 1)
      : Math.max(ev.taskDirs, census.total);
    const coverage = groups > 0 ? census.independent / groups : 0;
    if (census.independent > 0 && coverage >= 0.5) {
      reviewPts += 2;
      reviewNotes.push(`${census.independent} dispatched review(s) across ${groups} task group(s)`);
    } else if (census.independent > 0) {
      reviewPts += 1;
      reviewNotes.push(
        `${census.independent} dispatched review(s) across ${groups} task group(s) — thin coverage`,
      );
    } else {
      reviewNotes.push(`${census.selfChecks} self-check(s), no dispatched reviewer`);
    }
    if (census.finalReview === 'independent') {
      reviewPts += 2;
      reviewNotes.push('independent final review');
    } else if (census.finalReview === 'self') {
      reviewPts += 1;
      reviewNotes.push('final review is self-authored — weaker than an outside reader');
    } else {
      reviewNotes.push('no final review');
    }
    // A review that never rejected anything may still be a rubber stamp; one
    // that sent work back demonstrably was not.
    if (census.rejections > 0) {
      reviewPts += 1;
      reviewNotes.push(`${census.rejections} review round(s) rejected work before approving`);
    }
  }
  if (
    census.selfChecks > 0 &&
    census.independent === 0 &&
    (resolved === 'thorough' || total >= TASK_COUNT_ESCALATION_THRESHOLD)
  ) {
    reviewNotes.push('large/thorough session carried by self-checks only');
  }
  checks.push({
    id: 'reviews',
    label: 'Review depth (dispatched reviewers, not absence of markers)',
    points: Math.min(5, reviewPts),
    max: 5,
    notes: reviewNotes,
  });

  let score = checks.reduce((s, c) => s + c.points, 0);
  const maxScore = checks.reduce((s, c) => s + c.max, 0);
  /** @type {CapEntry[]} */
  const caps = [];

  if (isNonEmptyString(session.incompleteReason)) {
    const before = score;
    score = Math.min(score, 59);
    caps.push({
      id: 'incomplete',
      applied: true,
      before,
      after: score,
      text: `incompleteReason set ("${session.incompleteReason}") — score capped at 59 (was ${before})`,
    });
  }

  // A failing product loop is an outcome, and outcomes outrank artifacts: no
  // amount of spine/evidence polish should let a session with a red e2e run
  // read as an A.
  const health = sessionHealth({ cwd, sessionDir, session });
  if (health.state === 'red') {
    const before = score;
    const reason = health.reasons.join('; ');
    if (score > OUTCOME_CAP) {
      score = OUTCOME_CAP;
      caps.push({
        id: 'health-red',
        applied: true,
        before,
        after: score,
        text: `${reason} — score capped at ${OUTCOME_CAP} (was ${before})`,
      });
    } else {
      // F14: condition observed but score already ≤ ceiling — note only.
      caps.push({
        id: 'health-red',
        applied: false,
        before,
        after: score,
        text: reason,
      });
    }
  }

  // Money/auth/contracts/migrations have a hard floor: an independent
  // reviewer. Prose saying dispatch was declined does not survive session
  // cleanup; a cap does.
  // Fails closed, like pace resolution: a *negated* mention ("carries
  // consumption, never money") still counts as a money-shaped change, because
  // the cost of being wrong is one dispatched reviewer.
  //
  // Read from the SAME text the done gate reads. `enforceFinalReviewFloor` in
  // set-phase.mjs asks `collectPlanFacts`, which scans proposal/design/tasks
  // and the spine; this used to build its own string from slug + paceSignal +
  // change + spine only. A change that states its risk in plan prose — the
  // ordinary case, since a slug written at session start rarely says "auth" —
  // was therefore blocked by the gate and then scored uncapped, so the one
  // record that outlives cleanup stayed silent about the missing review.
  // Shipped that way in 0.3.22 and caught by this project's own telemetry.
  //
  // Union, not replacement: the plan is the richer source but a session with
  // no change dir (direct/throwaway) has only the local text, and neither may
  // make the floor less sensitive than it already was.
  const riskText = [session.paceSignal, session.slug, session.openspecChange, spineText]
    .filter(isNonEmptyString)
    .join(' ');
  const planHighRisk = planFacts?.highRisk === true;
  // The floor for a high-risk change is an independent reader of the *whole*
  // change. Per-group reviews do not substitute: they each saw one slice.
  if ((planHighRisk || isHighRiskText(riskText)) && census.finalReview !== 'independent') {
    const before = score;
    const what =
      census.finalReview === 'self'
        ? 'high-risk session whose final review is self-authored'
        : 'high-risk session with no independent final review';
    if (score > OUTCOME_CAP) {
      score = OUTCOME_CAP;
      caps.push({
        id: 'high-risk',
        applied: true,
        before,
        after: score,
        text: `${what} — score capped at ${OUTCOME_CAP} (was ${before}); dispatch a final reviewer, or record the refusal with --final-review-waived, which now survives cleanup in the digest`,
      });
    } else {
      // F14: already ≤ OUTCOME_CAP — record the condition without marking applied.
      caps.push({
        id: 'high-risk',
        applied: false,
        before,
        after: score,
        text: what,
      });
    }
  }

  // Review coverage floor (F13): the effective review.perTask knob prescribed
  // per-group reviewers and none showed up. Reads the SAME merged `census`
  // the high-risk cap above just read — never a fresh `reviewCensus(sessionDir)`
  // call — because re-measuring here would let this cap and the `forge phase
  // done` gate (which freezes its verdict onto the session) disagree, the
  // exact defect recorded in the comment above `census`'s construction. Task
  // count mirrors the gate's own source: `planFacts.tasks` when the plan is
  // readable, `session.tasksTotal` (already read into `total` above)
  // otherwise — no second read of the plan for this.
  //
  // `planFacts.tasks > 0`, not just `planFacts?.readable`, guards the same
  // absence-as-zero shape the `groups` denominator above guards with
  // `Math.max(planFacts.groups, 1)`: `collectPlanFacts` sets `readable` when
  // EITHER tasks.md OR proposal.md has content, but only ever counts `tasks`
  // from tasks.md checkbox lines. A change dir with a proposal and no
  // tasks.md — or a tasks.md with no checkboxes — is `readable: true,
  // tasks: 0`, and reading that 0 as a measurement defeated this cap's own
  // `tasks >= 5` guard, silently disabling F13 on any such session. Falling
  // back to `total` here, exactly as the unreadable branch already does, is
  // what treats "the plan didn't say" as unmeasured rather than as zero.
  const coverageTasks = planFacts?.readable && planFacts.tasks > 0 ? planFacts.tasks : total;
  // `review.perTask` is an independently overridable knob (preferences.mjs),
  // not derived from pace: `forge prefs -- --set review.perTask=never` sets
  // it at ANY pace, and gating this cap on `resolvedPace` alone (the first
  // shipped version) capped sessions that had correctly been told, via the
  // knob, to skip per-group reviewers — punishing the exact obedience this
  // cap exists to reward. Resolution is wrapped and defaulted to a
  // non-capping value (`null`) on any failure: an unreadable
  // `preferences.local.json` (or any other resolution problem) must not
  // throw here, and must not cap — an absence is not a measurement, the same
  // rule `reviewCoverageCap`'s own malformed-census guard follows.
  let perTaskReview = null;
  try {
    const effectivePrefs = resolveEffectivePreferences({ cwd, session });
    perTaskReview = effectivePrefs?.effective?.review?.perTask ?? null;
  } catch {
    perTaskReview = null;
  }
  const coverageCap = reviewCoverageCap({ census, perTaskReview, tasks: coverageTasks });
  // `coverageCap.cap` is a CEILING, never a floor: this must only ever lower
  // the score, never raise it. Deleting `score > coverageCap.cap` here left
  // all tests green while promoting a 59/D incomplete session (already
  // capped lower by `incompleteReason` above) to 89/B — the worst thing a
  // "cap" could do. See the paired invariant test in score.test.mjs.
  if (coverageCap && score > coverageCap.cap) {
    const before = score;
    score = coverageCap.cap;
    caps.push({
      id: 'review-coverage',
      applied: true,
      before,
      after: score,
      text: `${coverageCap.reason} — score capped at ${coverageCap.cap} (was ${before})`,
    });
  }

  const grade = gradeForScore(score);
  const changeDir = resolveChangeDir({ cwd, session });

  // Surfacing only (spec: "Allowances are recorded, reasoned, and
  // surfaced" — SHALL be listed in the scorecard). Deliberately never feeds
  // `score`/`caps`: an allowance is a reasoned, legitimate escape, not a
  // defect — penalising it would push agents toward using the guard's
  // bypasses without recording one, exactly what the allowance ledger
  // exists to avoid.
  const { allowances, error: allowancesError } = loadAllowancesForScorecard(sessionDir);

  return {
    version: 1,
    scoredAt: new Date().toISOString(),
    sessionId: session.id ?? null,
    slug: session.slug ?? null,
    phase: session.phase ?? null,
    openspecChange: session.openspecChange ?? null,
    changeDir,
    score,
    maxScore,
    grade,
    caps,
    checks,
    integrityOk: integrity.ok,
    allowances: allowances.map((a) => ({
      path: a.path,
      reason: a.reason,
      phase: a.phase ?? null,
      at: a.at ?? null,
    })),
    allowancesError,
    humanPrompts,
    interpretation: interpretGrade(grade, score, session),
  };
}

/**
 * @param {string} grade
 * @param {number} score
 * @param {Record<string, unknown>} session
 */
function interpretGrade(grade, score, session) {
  if (isNonEmptyString(session.incompleteReason)) {
    return `Session finished incomplete (${session.incompleteReason}). Process may be honest; product outcome is unproven — treat as Forge follow-up, not a green ship.`;
  }
  if (grade === 'A' || grade === 'B') {
    return `Strong L2 artifacts (${score}/100). Still confirm L3: exercise the product path or golden scenario before calling Forge successful.`;
  }
  if (grade === 'C') {
    return `Mixed L2 (${score}/100). Likely process gaps (spine/loop/evidence). Do not equate task checkboxes with product success.`;
  }
  return `Weak L2 (${score}/100). High risk of checkbox-green / product-hollow — same failure mode integrity was built to catch.`;
}

/**
 * @param {ReturnType<typeof scoreSession>} card
 */
export function formatScorecardMarkdown(card) {
  const lines = [];
  lines.push(`# Forge session scorecard`);
  lines.push('');
  lines.push(`- **Session:** ${card.sessionId ?? '?'}`);
  lines.push(`- **Slug:** ${card.slug ?? '?'}`);
  lines.push(`- **Change:** ${card.openspecChange ?? '(none)'}`);
  lines.push(`- **Phase:** ${card.phase ?? '?'}`);
  lines.push(`- **Score:** ${card.score}/${card.maxScore}  **Grade: ${card.grade}**`);
  lines.push(`- **Scored at:** ${card.scoredAt}`);
  lines.push(`- **Integrity OK:** ${card.integrityOk ? 'yes' : 'no'}`);
  lines.push('');
  lines.push(card.interpretation);
  lines.push('');
  if (card.caps.length) {
    lines.push('## Caps');
    for (const c of card.caps) lines.push(`- ${capText(c)}`);
    lines.push('');
  }
  if (card.allowancesError) {
    lines.push('## Allowances');
    lines.push('');
    lines.push(`guard-allowances.json is unreadable (${card.allowancesError}) — fix or remove it.`);
    lines.push('');
  } else if (card.allowances.length) {
    lines.push('## Allowances');
    lines.push('');
    for (const a of card.allowances) {
      lines.push(`- \`${a.path}\` (phase: ${a.phase ?? 'unknown'}): ${a.reason}`);
    }
    lines.push('');
  }
  lines.push('## Checks');
  lines.push('');
  lines.push('| Check | Points | Notes |');
  lines.push('| ----- | ------ | ----- |');
  for (const c of card.checks) {
    const notes = c.notes.map((n) => n.replace(/\|/g, '/')).join('; ') || '—';
    lines.push(`| ${c.label} | ${c.points}/${c.max} | ${notes} |`);
  }
  lines.push('');
  lines.push('## Human ship-check (L3 — answer after done)');
  lines.push('');
  for (const [i, q] of card.humanPrompts.entries()) {
    lines.push(`${i + 1}. ${q}`);
  }
  lines.push('');
  lines.push('Record answers below (optional but required for platform/async spines):');
  lines.push('');
  lines.push('```');
  lines.push('shipTomorrow: yes|no|follow-on');
  lines.push('notes:');
  lines.push('```');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/**
 * Durable one-line-per-session ledger at `.forge/scorecards.jsonl`. Sessions
 * are pruned after RETENTION_DAYS and scorecards die with them; the ledger
 * survives — it is the history `/forge:analyze` reads for trends. Re-scoring
 * a session replaces its line (latest score wins). Never throws.
 *
 * @param {string} sessionDir
 * @param {ReturnType<typeof scoreSession>} card
 * @param {Record<string, unknown>} session
 */
export function appendScorecardLedger(sessionDir, card, session = {}) {
  try {
    const file = path.join(path.resolve(sessionDir, '..', '..'), 'scorecards.jsonl');
    const line = {
      scoredAt: card.scoredAt,
      sessionId: card.sessionId,
      slug: card.slug,
      change: card.openspecChange,
      score: card.score,
      grade: card.grade,
      integrityOk: card.integrityOk,
      pace: session.resolvedPace ?? null,
      incompleteReason: session.incompleteReason ?? null,
      caps: card.caps,
      deductions: card.checks
        .filter((c) => c.points < c.max)
        .map((c) => ({ id: c.id, points: c.points, max: c.max, notes: c.notes })),
    };
    const kept = (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [])
      .filter(Boolean)
      .filter((l) => {
        try {
          return JSON.parse(l).sessionId !== card.sessionId;
        } catch {
          return false;
        }
      });
    kept.push(JSON.stringify(line));
    fs.writeFileSync(file, `${kept.join('\n')}\n`, 'utf8');
  } catch {
    /* ledger is advisory — never block a scorecard write */
  }
}

/**
 * Keep `session.json`'s cached score honest.
 *
 * The score lives in three places — scorecard.json, the sessions.jsonl digest,
 * and `session.score` / `session.scoreGrade`. Re-scoring rewrote the first two
 * and left the third asserting the old number, which was observed in the wild
 * as session.json claiming 97/A against a scorecard reading 69/C. Same shape as
 * ADR-0002: a derived cache heals when it diverges rather than being trusted.
 *
 * Reads and rewrites the file rather than serialising the in-memory object, so
 * nothing else on the session is touched — `updatedAt` in particular, because
 * re-scoring is not activity and bumping it would reset idle/STALE detection.
 *
 * @param {string} sessionDir
 * @param {Record<string, unknown>} session
 * @param {{ score: number, grade: string }} card
 */
function healCachedScore(sessionDir, session, card) {
  if (session && typeof session === 'object') {
    session.score = card.score;
    session.scoreGrade = card.grade;
  }
  try {
    const file = path.join(sessionDir, 'session.json');
    const onDisk = readJson(file);
    if (onDisk.score === card.score && onDisk.scoreGrade === card.grade) return;
    onDisk.score = card.score;
    onDisk.scoreGrade = card.grade;
    writeJson(file, onDisk);
  } catch {
    /* advisory — a cache that cannot be healed must not cost the scorecard */
  }
}

/**
 * Write scorecard.json + scorecard.md into the session dir, and mirror a
 * summary line into the durable `.forge/scorecards.jsonl` ledger.
 *
 * @param {{ cwd?: string, sessionDir: string, session: Record<string, unknown> }} opts
 */
export function writeSessionScorecard(opts) {
  const card = scoreSession(opts);
  const jsonPath = path.join(opts.sessionDir, 'scorecard.json');
  const mdPath = path.join(opts.sessionDir, 'scorecard.md');
  writeJson(jsonPath, card);
  fs.writeFileSync(mdPath, formatScorecardMarkdown(card), 'utf8');
  healCachedScore(opts.sessionDir, opts.session, card);
  appendScorecardLedger(opts.sessionDir, card, opts.session);
  // Durable ledgers: the session dir is deleted at cleanup, so the digest and
  // any unresolved deferrals have to leave the session while it still exists.
  appendSessionDigest({ cwd: opts.cwd, sessionDir: opts.sessionDir, session: opts.session, card });
  appendDeferralLedger({ cwd: opts.cwd, sessionDir: opts.sessionDir, session: opts.session });
  return { card, jsonPath, mdPath };
}
