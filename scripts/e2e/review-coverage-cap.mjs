#!/usr/bin/env node
/**
 * Product loop for review-coverage-cap — drive the shipped forge binary
 * against scratch sessions in a throwaway project: build five session
 * fixtures on disk (thorough/standard pace with zero, one-final-only, and
 * full review coverage; brisk pace; a small-task session), score each one
 * through the real `forge score` CLI (never by importing `scoreSession`
 * directly), and assert the review-coverage cap in `packages/cli/src/score.mjs`
 * (`reviewCoverageCap`) fires — and only fires — where the spec says it must.
 *
 * This pins the exact inversion a previous release shipped and had to be
 * reverted for: it capped the *reviewed* session and let the *unreviewed* one
 * through. Case 6 ("monotone") asserts the ordering directly rather than
 * inferring it from the other cases.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FORGE_BIN = path.join(REPO, 'packages', 'cli', 'bin', 'forge.mjs');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-e2e-review-coverage-cap-'));
const PROJECT = path.join(SCRATCH, 'project');

function forge(cwd, args) {
  const env = { ...process.env, FORGEKIT_FLEET_DIR: path.join(SCRATCH, '.fleet') };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CURSOR_CONVERSATION_ID;
  delete env.CURSOR_TRACE_ID;
  const r = spawnSync(process.execPath, [FORGE_BIN, ...args], { cwd, encoding: 'utf8', env });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(1);
}

fs.mkdirSync(path.join(PROJECT, '.forge'), { recursive: true });

// Bland throughout — slug, pace signal, spine reason, review prose — none of
// it may contain a money/auth/contract/migration/secret word. `isHighRiskText`
// (packages/cli/src/preferences.mjs) scans the slug, pace signal, plan text
// and spine for exactly those words and caps at 69 for a different, unrelated
// reason; a fixture that trips it would make case 3 ("reviewed" must be
// uncapped) fail confusingly, or make case 1/2 pass for the wrong reason.
const BLAND_SLUG = 'telemetry-dashboard-rollup';
const BLAND_SIGNAL = 'aggregate nightly dashboard telemetry counts';
const SPINE_REASON = 'sync HTTP only — informational fixture for the review-coverage-cap e2e loop';

/**
 * An independent per-group/final review: opening paragraphs name a reviewer
 * that is not the coordinator/author, and carry none of `SELF_REVIEW_RE`'s
 * self-declaration phrases (packages/cli/src/review-census.mjs) — no
 * "self-review/self-check/self-audit/self-authored", no "Reviewer: coordinator",
 * no "APPROVED (pace ...)"/"SKIPPED (pace ...)". reviewCensus() only reads
 * this attribution region, so body prose beyond it is irrelevant to the verdict.
 */
function independentReviewBody(reviewer) {
  return (
    `# Review\n\nReviewer: ${reviewer}\n\n` +
    'Read the change against the plan end to end. Tests pass, behavior matches ' +
    'the described plan, no gaps found.\n\nApproved.\n'
  );
}

/**
 * Build one session fixture and return its session id.
 *
 * @param {{ resolvedPace: string, tasksTotal: number, tasksComplete: number,
 *   finalReview?: boolean, groupReview?: boolean }} opts
 */
function buildSession(opts) {
  const created = forge(PROJECT, ['new', BLAND_SLUG, '--signal', BLAND_SIGNAL]);
  if (created.code !== 0) fail(`forge new failed: ${created.stderr}`);
  let out;
  try {
    out = JSON.parse(created.stdout);
  } catch {
    fail(`forge new stdout not JSON: ${created.stdout.slice(0, 200)}`);
  }
  const sessionId = out.sessionId;
  const sessionDir = path.join(PROJECT, '.forge', 'sessions', sessionId);

  // Pin the pace and task count directly on disk — the same on-disk fields
  // `forge score` reads — rather than relying on the auto-pace-signal regex
  // to land on exactly the pace this fixture needs to prove.
  const sessionFile = path.join(sessionDir, 'session.json');
  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  session.pace = opts.resolvedPace;
  session.resolvedPace = opts.resolvedPace;
  session.pacePinned = true;
  session.tasksTotal = opts.tasksTotal;
  session.tasksComplete = opts.tasksComplete;
  fs.writeFileSync(sessionFile, `${JSON.stringify(session, null, 2)}\n`, 'utf8');

  // No tracked change (openspecChange stays null), so spine.json/verify-evidence.md
  // live directly in the session dir (packages/cli/src/integrity.mjs `spinePath`).
  fs.writeFileSync(
    path.join(sessionDir, 'spine.json'),
    `${JSON.stringify({ change: null, notApplicable: SPINE_REASON, rows: [] }, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# Verify\n\nExit 0\n', 'utf8');

  // One real task dir with tier-2 evidence, present in every fixture equally
  // so the "tasks" check contributes the same baseline points everywhere —
  // differences between fixtures come only from pace/tasks/review inputs.
  const taskDir = path.join(sessionDir, 'tasks', '01-model');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, 'test-evidence.md'),
    '# Test evidence\n\n- **Exit code:** 0\n- **Summary:** asserts the row is written\n',
    'utf8',
  );

  if (opts.finalReview) {
    const reviewsDir = path.join(sessionDir, 'reviews');
    fs.mkdirSync(reviewsDir, { recursive: true });
    fs.writeFileSync(path.join(reviewsDir, 'final-review.md'), independentReviewBody('morgan-model'), 'utf8');
  }

  if (opts.groupReview) {
    // Named group-review.md with no test-evidence.md/brief.md beside it, so
    // score.mjs's `isReviewContainer` excludes this dir from the task-evidence
    // denominator — it is a review, not a unit of work needing one.
    const groupDir = path.join(sessionDir, 'tasks', 'group-01');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'group-review.md'), independentReviewBody('quinn-model'), 'utf8');
  }

  return sessionId;
}

/** Score a session through the real `forge score` CLI and parse its JSON. */
function scoreOf(sessionId) {
  const r = forge(PROJECT, ['score', '--session', sessionId]);
  if (r.code !== 0) fail(`forge score failed for ${sessionId}: ${r.stderr}`);
  let card;
  try {
    card = JSON.parse(r.stdout);
  } catch {
    fail(`forge score stdout not JSON: ${r.stdout.slice(0, 200)}`);
  }
  return card;
}

/** Sum of check points, independent of any cap — the pre-cap ("raw") score. */
function rawScoreOf(card) {
  if (!Array.isArray(card.checks)) fail('scorecard has no checks array');
  return card.checks.reduce((s, c) => s + c.points, 0);
}

// --- 1. zero: thorough/standard pace, >=5 tasks, no review artifacts at all ---
const zeroId = buildSession({ resolvedPace: 'standard', tasksTotal: 6, tasksComplete: 6 });
const zeroCard = scoreOf(zeroId);
const zeroRaw = rawScoreOf(zeroCard);
if (zeroRaw <= 69) {
  fail(
    `zero fixture's own raw (pre-cap) score is ${zeroRaw} <= 69 — this fixture cannot prove the cap fired, ` +
      'it proves nothing about the score being reduced',
  );
}
if (zeroCard.score !== 69) {
  fail(`zero: expected capped score 69, got ${zeroCard.score} (caps: ${JSON.stringify(zeroCard.caps)})`);
}
if (zeroCard.caps.length !== 1) {
  fail(`zero: expected exactly one cap to fire, got ${zeroCard.caps.length}: ${JSON.stringify(zeroCard.caps)}`);
}

// --- 2. finalOnly: same, plus an independent final review -> cap softens to 89 ---
const finalOnlyId = buildSession({
  resolvedPace: 'standard',
  tasksTotal: 6,
  tasksComplete: 6,
  finalReview: true,
});
const finalOnlyCard = scoreOf(finalOnlyId);
const finalOnlyRaw = rawScoreOf(finalOnlyCard);
if (finalOnlyRaw <= 89) {
  fail(`finalOnly fixture's own raw (pre-cap) score is ${finalOnlyRaw} <= 89 — cannot prove the softened cap fired`);
}
if (finalOnlyCard.score !== 89) {
  fail(
    `finalOnly: expected capped score 89, got ${finalOnlyCard.score} (caps: ${JSON.stringify(finalOnlyCard.caps)})`,
  );
}
if (finalOnlyCard.score <= 69) fail(`finalOnly: score ${finalOnlyCard.score} did not clear the harsher 69 tier`);
if (finalOnlyCard.caps.length !== 1) {
  fail(
    `finalOnly: expected exactly one cap to fire, got ${finalOnlyCard.caps.length}: ${JSON.stringify(finalOnlyCard.caps)}`,
  );
}

// --- 3. reviewed: same, plus an independent per-group review -> no cap at all ---
const reviewedId = buildSession({
  resolvedPace: 'standard',
  tasksTotal: 6,
  tasksComplete: 6,
  finalReview: true,
  groupReview: true,
});
const reviewedCard = scoreOf(reviewedId);
if (reviewedCard.caps.length !== 0) {
  fail(
    `reviewed: expected zero caps (independent per-group review must lift the cap entirely), got ` +
      `${JSON.stringify(reviewedCard.caps)}`,
  );
}
if (reviewedCard.score <= 89) {
  fail(`reviewed: expected score > 89 (uncapped), got ${reviewedCard.score}`);
}
if (reviewedCard.score !== rawScoreOf(reviewedCard)) {
  fail(`reviewed: score ${reviewedCard.score} differs from its own raw sum ${rawScoreOf(reviewedCard)} — something capped it`);
}

// --- 4. brisk: brisk pace, >=5 tasks, zero reviews -> pace exemption, no cap ---
const briskId = buildSession({ resolvedPace: 'brisk', tasksTotal: 6, tasksComplete: 6 });
const briskCard = scoreOf(briskId);
if (briskCard.caps.length !== 0) {
  fail(`brisk: expected zero caps (brisk pace is exempt), got ${JSON.stringify(briskCard.caps)}`);
}
if (briskCard.score !== rawScoreOf(briskCard)) {
  fail(`brisk: score ${briskCard.score} differs from its own raw sum ${rawScoreOf(briskCard)} — something capped it`);
}

// --- 5. small: standard pace, <5 tasks, zero reviews -> task-count exemption, no cap ---
const smallId = buildSession({ resolvedPace: 'standard', tasksTotal: 3, tasksComplete: 3 });
const smallCard = scoreOf(smallId);
if (smallCard.caps.length !== 0) {
  fail(`small: expected zero caps (fewer than 5 tasks is exempt), got ${JSON.stringify(smallCard.caps)}`);
}
if (smallCard.score !== rawScoreOf(smallCard)) {
  fail(`small: score ${smallCard.score} differs from its own raw sum ${rawScoreOf(smallCard)} — something capped it`);
}

// --- 6. monotone: the exact inversion a reverted release shipped. A session
// with zero reviews must never outscore one with full review coverage. ---
if (zeroCard.score > reviewedCard.score) {
  fail(
    `monotone violated: zero-review score ${zeroCard.score} > reviewed score ${reviewedCard.score} — ` +
      'this is the exact inversion the 0.3.25 release shipped and was reverted for',
  );
}

process.stdout.write(
  'COVERAGE-CAP zero=capped69 finalOnly=capped89 reviewed=uncapped brisk=uncapped small=uncapped monotone=ok\n',
);
fs.rmSync(SCRATCH, { recursive: true, force: true });
