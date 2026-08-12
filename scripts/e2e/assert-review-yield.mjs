#!/usr/bin/env node
/**
 * Product loop for D5's review-yield table (`buildAnalysis`/`formatAnalysis`
 * in packages/cli/src/analyze.mjs, surfaced by `forge analyze`).
 *
 * The table must be computed from Forge's OWN recorded review stamps
 * (`entry.reviews.independent` / `.rejections`, written by `reviewCensus` at
 * `forge phase done`), never from harvested host telemetry
 * (`entry.metrics`/`subagentsDispatched`). The two sources usually agree, so a
 * fixture where they agree proves nothing — that exact mistake is what group
 * 5's own implementation was caught making. This fixture is deliberately
 * DISCRIMINATING: one session carries `metrics.available: false` and
 * `subagentsDispatched: 0` (failed telemetry) alongside a genuinely non-zero
 * `reviews.independent` (a real recorded review). If the table reports that
 * pace's reviews as non-zero, the figure came from the stamps; if it reports
 * zero, it came from telemetry.
 *
 * Also asserts:
 *   - a pace nothing was ever recorded at emits no row (no zero-row clutter);
 *   - an exit-ramp row (`exitReason` set — the plan-time exit ramp, D2)
 *     carries a real, already-resolved pace — `forge new` resolves one
 *     immediately, so this does NOT carry `pace: null` — and must not count
 *     toward that pace's `sessions`, since it never reached review ceremony
 *     at it;
 *   - a `phase: "skipped"` row with NO `exitReason` (a `/forge:skip` on a
 *     session already mid-work — `skills/forge/SKILL.md` and
 *     `templates/project/claude/commands/forge-skip.md` both route that
 *     through the identical `forge phase skipped`) is a DIFFERENT shape and
 *     DOES count: it can carry real tasks and real reviews that the table's
 *     spec requires it to report. Both fixtures below share the same pace
 *     (`thorough`) so the resulting row proves the split precisely — it
 *     must equal the abandoned session alone, not the sum of both.
 *
 * Drives the SHIPPED binary (`forge analyze` and `forge analyze --json`)
 * against a scratch `.forge/sessions.jsonl` — never a real ledger in this
 * checkout — layered onto the same temp project
 * `scripts/e2e/harness-portability.mjs`'s `boot` phase builds.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FORGE_BIN = path.join(REPO, 'packages', 'cli', 'bin', 'forge.mjs');
// Same path formula as harness-portability.mjs's SCRATCH — layered onto
// whatever `boot-scratch-project` already built there. `ensureBootedProject`
// below makes this script runnable standalone (tier-2) before `boot` ever
// has, mirroring assert-pace-two-way.mjs.
const SCRATCH = path.join(
  os.tmpdir(),
  `forgekit-e2e-harness-${createHash('sha256').update(REPO).digest('hex').slice(0, 10)}`,
);

function fail(message, context) {
  process.stderr.write(`ASSERTION FAILED: ${message}\n${context ?? ''}\n`);
  process.exit(1);
}

function forge(cwd, args) {
  const env = { ...process.env, FORGEKIT_FLEET_DIR: path.join(SCRATCH, '.fleet') };
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync(process.execPath, [FORGE_BIN, ...args], { cwd, encoding: 'utf8', env });
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '', code: r.status };
}

/** Duplicated from harness-portability.mjs's own `makeProject` shape — see assert-pace-two-way.mjs for why. */
function ensureBootedProject(dir) {
  if (fs.existsSync(path.join(dir, '.forge', 'config.json'))) return;
  fs.mkdirSync(dir, { recursive: true });
  const sessionDir = path.join(dir, '.forge', 'sessions', 's1');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify({ id: 's1', slug: 'scratch', planType: 'specs', openspecChange: 'my-change' })}\n`,
  );
  fs.writeFileSync(path.join(dir, '.forge', 'active.json'), `${JSON.stringify({ sessionId: 's1' })}\n`);
  fs.writeFileSync(
    path.join(dir, '.forge', 'config.json'),
    `${JSON.stringify({ plan: { engine: 'specs', dir: 'specs' } }, null, 2)}\n`,
  );
  fs.mkdirSync(path.join(dir, 'specs', 'changes', 'my-change'), { recursive: true });
}
ensureBootedProject(SCRATCH);

/**
 * One `.forge/sessions.jsonl` digest line, the shape `appendSessionDigest`
 * (packages/cli/src/ledger.mjs) writes.
 */
function digestLine({ sessionId, phase = 'done', pace, tasksComplete, tasksTotal, independent, rejections, metricsAvailable, subagentsDispatched, exitReason = null, endedAt }) {
  return JSON.stringify({
    sessionId,
    slug: sessionId,
    change: null,
    phase,
    planType: 'specs',
    pace,
    tasks: `${tasksComplete}/${tasksTotal}`,
    subagentsDispatched,
    dispatchesSkipped: 0,
    dispatches: null,
    metrics: { available: metricsAvailable },
    reviews: { total: independent, independent, selfChecks: 0, rejections, final: independent > 0 ? 'independent' : null },
    grade: null,
    health: null,
    exitReason,
    startedAt: endedAt,
    endedAt,
  });
}

const now = Date.now();
const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();

// The discriminating fixture: failed telemetry, real recorded reviews. On
// `lite` alone, so the assertion below can name it precisely rather than
// reading it out of a sum.
const DISCRIMINATING = digestLine({
  sessionId: 'fixture-lite-failed-telemetry',
  pace: 'lite',
  tasksComplete: 3,
  tasksTotal: 3,
  independent: 3,
  rejections: 0,
  metricsAvailable: false,
  subagentsDispatched: 0,
  endedAt: at(10),
});

// An ordinary session with metrics collection working, for a second pace and
// a non-zero rejections/100-tasks figure.
const ORDINARY = digestLine({
  sessionId: 'fixture-brisk-ordinary',
  pace: 'brisk',
  tasksComplete: 5,
  tasksTotal: 5,
  independent: 1,
  rejections: 1,
  metricsAvailable: true,
  subagentsDispatched: 5,
  endedAt: at(20),
});

// Zero declared tasks — the division-by-zero guard on reviewsPerTask /
// rejectionsPer100Tasks.
const ZERO_TASKS = digestLine({
  sessionId: 'fixture-standard-zero-tasks',
  pace: 'standard',
  tasksComplete: 0,
  tasksTotal: 0,
  independent: 2,
  rejections: 0,
  metricsAvailable: false,
  subagentsDispatched: 0,
  endedAt: at(30),
});

// A session that left through the plan-time exit ramp (D2), `--exit-reason`
// set. `forge new` resolves a pace immediately, so this does NOT carry
// `pace: null` — it carries the real, already-resolved pace and `phase:
// 'skipped'`, `tasks: '0/0'`. It never reached review ceremony at that pace,
// so it must contribute nothing to it. Uses `thorough` deliberately — no
// other fixture runs at `thorough`, so this and ABANDONED below are the only
// contributors, which is what makes the split below unambiguous.
const EXIT_RAMP = digestLine({
  sessionId: 'fixture-exit-ramp',
  phase: 'skipped',
  pace: 'thorough',
  tasksComplete: 0,
  tasksTotal: 0,
  independent: 0,
  rejections: 0,
  metricsAvailable: false,
  subagentsDispatched: 0,
  exitReason: '2 task(s), single capability, no spine rows — small enough to leave Forge',
  endedAt: at(40),
});

// I3-R: `phase: 'skipped'` is not only the exit ramp — `/forge:skip` on a
// session already mid-work writes the identical `phase: 'skipped'`, with no
// `exitReason` (that flag's only documented producer, `forge exit-check`,
// fires at plan time, before any tasks exist). This session has real tasks
// and real recorded reviews and MUST count — dropping it silently discarded
// exactly the shape `session-lifecycle` says must never be silent about.
// Same pace as EXIT_RAMP (`thorough`) on purpose: if the exclusion regressed
// back to gating on `phase` instead of `exitReason`, the `thorough` row
// would vanish entirely; if it regressed the other way (stopped excluding
// the exit ramp at all), the row would double-count. Only the correct gate
// leaves `thorough` showing ABANDONED's numbers alone.
const ABANDONED = digestLine({
  sessionId: 'fixture-abandoned-mid-work',
  phase: 'skipped',
  pace: 'thorough',
  tasksComplete: 8,
  tasksTotal: 12,
  independent: 3,
  rejections: 1,
  metricsAvailable: false,
  subagentsDispatched: 0,
  exitReason: null,
  endedAt: at(35),
});

fs.writeFileSync(
  path.join(SCRATCH, '.forge', 'sessions.jsonl'),
  `${[DISCRIMINATING, ORDINARY, ZERO_TASKS, EXIT_RAMP, ABANDONED].join('\n')}\n`,
  'utf8',
);
// No surviving metrics.json / scorecards.jsonl for any of these fixture ids —
// buildAnalysis must fall back to the digest's own `reviews`/`metrics`
// fields, never crash for their absence.

const jsonRun = forge(SCRATCH, ['analyze', '--json']);
if (jsonRun.code !== 0) fail(`forge analyze --json exited ${jsonRun.code}`, jsonRun.out);
let analysis;
try {
  analysis = JSON.parse(jsonRun.stdout);
} catch {
  fail('forge analyze --json did not print JSON', jsonRun.out);
}

const yieldTable = analysis.reviewYield ?? {};

// --- the discriminating assertion: failed telemetry must not read as zero reviews ---
const lite = yieldTable.lite;
if (!lite) fail('reviewYield has no "lite" row at all', JSON.stringify(yieldTable, null, 2));
if (lite.independentReviews !== 3) {
  fail(
    `lite pace (metrics.available:false, subagentsDispatched:0, reviews.independent:3) reports ` +
      `independentReviews=${lite.independentReviews}, expected 3 — a session with failed metrics ` +
      'collection is being counted as zero reviews (reading telemetry, not the recorded stamps)',
    JSON.stringify(lite, null, 2),
  );
}
if (lite.sessions !== 1 || lite.tasks !== 3) {
  fail(`lite row has the wrong sessions/tasks: ${JSON.stringify(lite)}`, JSON.stringify(yieldTable, null, 2));
}

// --- the ordinary session, for a second pace and a non-zero rejection rate ---
const brisk = yieldTable.brisk;
if (!brisk) fail('reviewYield has no "brisk" row', JSON.stringify(yieldTable, null, 2));
if (brisk.independentReviews !== 1 || brisk.rejections !== 1 || brisk.tasks !== 5) {
  fail(`brisk row does not match its fixture: ${JSON.stringify(brisk)}`, JSON.stringify(yieldTable, null, 2));
}
if (Math.abs(brisk.rejectionsPer100Tasks - 20) > 1e-9) {
  fail(`brisk rejectionsPer100Tasks expected 20, got ${brisk.rejectionsPer100Tasks}`, JSON.stringify(brisk, null, 2));
}

// --- zero-task guard: reviewsPerTask/rejectionsPer100Tasks must not be NaN/Infinity ---
const standard = yieldTable.standard;
if (!standard) fail('reviewYield has no "standard" row', JSON.stringify(yieldTable, null, 2));
if (standard.independentReviews !== 2) {
  fail(`standard row lost its recorded reviews: ${JSON.stringify(standard)}`, JSON.stringify(yieldTable, null, 2));
}
if (!Number.isFinite(standard.reviewsPerTask) || standard.reviewsPerTask !== 0) {
  fail(
    `standard pace has 0 tasks but 2 recorded reviews — reviewsPerTask must be the guarded 0, got ${standard.reviewsPerTask}`,
    JSON.stringify(standard, null, 2),
  );
}
if (!Number.isFinite(standard.rejectionsPer100Tasks) || standard.rejectionsPer100Tasks !== 0) {
  fail(
    `standard pace's rejectionsPer100Tasks must be the guarded 0 on a 0-task session, got ${standard.rejectionsPer100Tasks}`,
    JSON.stringify(standard, null, 2),
  );
}

// --- "thorough" is the exit-ramp-vs-abandoned split proof ---
// EXIT_RAMP (exitReason set, tasks 0/0) and ABANDONED (no exitReason, tasks
// 8/12, 3 reviews, 1 rejection) both carry `pace: 'thorough'`, and no other
// fixture runs there. The row must equal ABANDONED alone: `sessions` proves
// EXIT_RAMP was excluded (1, not 2 — EXIT_RAMP's own tasks/reviews are all
// zero, so only `sessions` would move if it leaked in); the other columns
// prove ABANDONED was NOT also dropped by an over-broad `phase` gate.
const thorough = yieldTable.thorough;
if (!thorough) fail('reviewYield has no "thorough" row — the abandoned mid-work session was dropped', JSON.stringify(yieldTable, null, 2));
if (thorough.sessions !== 1) {
  fail(
    `thorough.sessions expected 1 (ABANDONED only) got ${thorough.sessions} — the exit-ramp exclusion broke and let EXIT_RAMP count toward "sessions"`,
    JSON.stringify(thorough, null, 2),
  );
}
if (thorough.tasks !== 12 || thorough.independentReviews !== 3 || thorough.rejections !== 1) {
  fail(
    `thorough row does not match the abandoned-session fixture alone: ${JSON.stringify(thorough)} — a ` +
      '`phase:"skipped"` gate (instead of `exitReason`) would drop this real work too',
    JSON.stringify(yieldTable, null, 2),
  );
}

// --- a pace nothing was ever recorded at emits no row (no zero-row clutter) ---
for (const absent of ['auto']) {
  if (Object.prototype.hasOwnProperty.call(yieldTable, absent)) {
    fail(`reviewYield has a row for "${absent}", which no fixture ever ran at`, JSON.stringify(yieldTable, null, 2));
  }
}
for (const [pace, row] of Object.entries(yieldTable)) {
  if (!Number.isFinite(row.reviewsPerTask) || !Number.isFinite(row.rejectionsPer100Tasks)) {
    fail(`reviewYield.${pace} carries a non-finite figure (NaN/Infinity)`, JSON.stringify(row, null, 2));
  }
}

// --- the human-readable table must also print (`forge analyze`, no --json) ---
const textRun = forge(SCRATCH, ['analyze']);
if (textRun.code !== 0) fail(`forge analyze exited ${textRun.code}`, textRun.out);
if (!textRun.out.includes('Review yield by pace')) {
  fail('forge analyze (text) did not print the review-yield table at all', textRun.out);
}
if (!/\blite\b/.test(textRun.out) || !/\bbrisk\b/.test(textRun.out) || !/\bstandard\b/.test(textRun.out)) {
  fail('forge analyze (text) table is missing an expected pace row', textRun.out);
}

process.stdout.write(
  `review-yield: lite=${lite.independentReviews}/${lite.tasks} (failed-telemetry session counted from stamps), ` +
    `brisk=${brisk.independentReviews}/${brisk.tasks} rej/100=${brisk.rejectionsPer100Tasks}, ` +
    `standard=${standard.independentReviews}/${standard.tasks} (guarded, no NaN), ` +
    `thorough=${thorough.independentReviews}/${thorough.tasks} (abandoned mid-work counted, exit-ramp sibling excluded), ` +
    'unrecorded paces: no row\n',
);
