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
 *   - a `phase: "skipped"` session (one that left through the plan-time exit
 *     ramp, D2) carries a real, already-resolved pace — `forge new` resolves
 *     one immediately, so this does NOT carry `pace: null` — and must not
 *     count toward that pace's `sessions`, since it never reached review
 *     ceremony at it.
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
function digestLine({ sessionId, phase = 'done', pace, tasksComplete, tasksTotal, independent, rejections, metricsAvailable, subagentsDispatched, endedAt }) {
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

// A session that left through the plan-time exit ramp (D2). `forge new`
// resolves a pace immediately, so this does NOT carry `pace: null` — it
// carries the real, already-resolved pace and `phase: 'skipped'`, `tasks:
// '0/0'`. It never reached review ceremony at that pace, so it must produce
// no row (not a zero row) for it. Uses `thorough` deliberately — no other
// fixture runs at `thorough`, so a stray row is unambiguous, and the "absent
// paces" loop below (which already checks `thorough`) is what proves the
// exclusion.
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
  endedAt: at(40),
});

fs.writeFileSync(
  path.join(SCRATCH, '.forge', 'sessions.jsonl'),
  `${[DISCRIMINATING, ORDINARY, ZERO_TASKS, EXIT_RAMP].join('\n')}\n`,
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

// --- absent paces emit no row — "thorough" doubles as the exit-ramp proof: ---
// EXIT_RAMP carries `pace: 'thorough'` and `phase: 'skipped'`, and no other
// fixture runs at `thorough`, so a row appearing here means the exit-ramp
// exclusion broke, not that a real session ran unrecorded.
for (const absent of ['thorough']) {
  if (Object.prototype.hasOwnProperty.call(yieldTable, absent)) {
    fail(
      `reviewYield has a row for "${absent}" — either a fixture ran there unexpectedly, or the ` +
        'phase:"skipped" (exit-ramp) exclusion broke and let EXIT_RAMP count toward it',
      JSON.stringify(yieldTable, null, 2),
    );
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
    'absent paces: no row, exit-ramp (phase:skipped, real pace): no bucket\n',
);
