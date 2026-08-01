#!/usr/bin/env node
/**
 * Product loop for score-coverage-denominator (F16 + F14) — drive the shipped
 * forge binary against scratch sessions in a throwaway project:
 *
 * 1. tasks.md with one numbered group + ## Notes + a fenced ## heading scores
 *    review-depth as `across 1 task group(s)` (Notes/fence must not inflate).
 * 2. A session that only records a noted cap (`applied: false`) must not show
 *    as capped in `forge fleet report`.
 * 3. A session with an applied cap must show as capped in fleet (or scorecard).
 *
 * Status line (exact): `DENOM groups=1 noted-cap=ok applied-cap=ok`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FORGE_BIN = path.join(REPO, 'packages', 'cli', 'bin', 'forge.mjs');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-e2e-score-coverage-denominator-'));
const PROJECT = path.join(SCRATCH, 'project');
const CHANGE = 'denom-change';

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

function capText(c) {
  return typeof c === 'string' ? c : (c?.text ?? '');
}

function independentReviewBody(reviewer) {
  return (
    `# Review\n\nReviewer: ${reviewer}\n\n` +
    'Read the change against the plan end to end. Tests pass, behavior matches ' +
    'the described plan, no gaps found.\n\nApproved.\n'
  );
}

/** Score via CLI; D/F grades exit 1 but still emit JSON on stdout. */
function scoreOf(sessionId, { write = false } = {}) {
  const args = ['score', '--session', sessionId];
  if (write) args.push('--write');
  const r = forge(PROJECT, args);
  let card;
  try {
    card = JSON.parse(r.stdout);
  } catch {
    fail(`forge score stdout not JSON (exit ${r.code}): ${r.stdout.slice(0, 300)}\nstderr: ${r.stderr.slice(0, 300)}`);
  }
  return card;
}

function fleetReport() {
  const r = forge(PROJECT, ['fleet', 'report', '--json']);
  if (r.code !== 0) fail(`forge fleet report failed: ${r.stderr}`);
  let report;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    fail(`fleet report stdout not JSON: ${r.stdout.slice(0, 300)}`);
  }
  return report;
}

function findFleetSession(report, sessionId) {
  for (const p of report.projects ?? []) {
    const hit = (p.sessions ?? []).find((s) => s.sessionId === sessionId);
    if (hit) return hit;
  }
  return null;
}

function patchSession(sessionId, patch) {
  const sessionFile = path.join(PROJECT, '.forge', 'sessions', sessionId, 'session.json');
  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  Object.assign(session, patch);
  fs.writeFileSync(sessionFile, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
  return session;
}

function plantBaselineArtifacts(sessionDir, { spineReason = 'sync HTTP only — denom e2e' } = {}) {
  fs.writeFileSync(
    path.join(sessionDir, 'spine.json'),
    `${JSON.stringify({ change: null, notApplicable: spineReason, rows: [] }, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# Verify\n\nExit 0\n', 'utf8');
  const taskDir = path.join(sessionDir, 'tasks', '01-model');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, 'test-evidence.md'),
    '# Test evidence\n\n- **Exit code:** 0\n- **Summary:** asserts the row is written\n',
    'utf8',
  );
}

function forgeNew(slug, signal) {
  const created = forge(PROJECT, ['new', slug, '--signal', signal]);
  if (created.code !== 0) fail(`forge new ${slug} failed: ${created.stderr}`);
  let out;
  try {
    out = JSON.parse(created.stdout);
  } catch {
    fail(`forge new stdout not JSON: ${created.stdout.slice(0, 200)}`);
  }
  return out.sessionId;
}

// --- project scaffold ---
fs.mkdirSync(path.join(PROJECT, '.forge'), { recursive: true });
fs.writeFileSync(
  path.join(PROJECT, '.forge', 'config.json'),
  `${JSON.stringify({ plan: { engine: 'specs', dir: 'specs' } }, null, 2)}\n`,
  'utf8',
);

const changeDir = path.join(PROJECT, 'specs', 'changes', CHANGE);
fs.mkdirSync(changeDir, { recursive: true });
fs.writeFileSync(path.join(changeDir, 'proposal.md'), '# Proposal\n\nDenominator fixture.\n', 'utf8');
fs.writeFileSync(
  path.join(changeDir, 'spine.json'),
  `${JSON.stringify({ change: CHANGE, notApplicable: 'sync reads only', rows: [] }, null, 2)}\n`,
  'utf8',
);
// ONE numbered group; ## Notes and a fenced ## must not inflate the count.
fs.writeFileSync(
  path.join(changeDir, 'tasks.md'),
  [
    '# Tasks',
    '',
    '## 1. Protect the denominator',
    '- [x] 1.1 strip fences',
    '- [x] 1.2 numbered GROUP_RE',
    '',
    '## Notes',
    '- leftover thoughts that must not count as a task group',
    '',
    '```md',
    '## 99. Fake group inside fence',
    '- [ ] should not count as a task either if fenced',
    '```',
    '',
  ].join('\n'),
  'utf8',
);

// ========== 1. groups denominator ==========
const groupsId = forgeNew('telemetry-dashboard-rollup', 'aggregate nightly dashboard telemetry counts');
patchSession(groupsId, {
  planType: 'specs',
  openspecChange: CHANGE,
  resolvedPace: 'standard',
  pace: 'standard',
  pacePinned: true,
  tasksTotal: 2,
  tasksComplete: 2,
});
const groupsDir = path.join(PROJECT, '.forge', 'sessions', groupsId);
plantBaselineArtifacts(groupsDir);
const groupReviewDir = path.join(groupsDir, 'tasks', 'group-01');
fs.mkdirSync(groupReviewDir, { recursive: true });
fs.writeFileSync(path.join(groupReviewDir, 'group-review.md'), independentReviewBody('quinn-model'), 'utf8');

const groupsCard = scoreOf(groupsId);
const reviewNotes = (groupsCard.checks?.find((c) => c.id === 'reviews')?.notes ?? []).join(' ');
if (!/across 1 task group\(s\)/.test(reviewNotes)) {
  fail(`groups: expected "across 1 task group(s)" in review notes, got: ${reviewNotes || '(empty)'}`);
}
if (/thin coverage/.test(reviewNotes)) {
  fail(`groups: one review of one group must not be thin; notes: ${reviewNotes}`);
}
if (/across [2-9]\d* task group/.test(reviewNotes)) {
  fail(`groups: Notes/fence inflated the denominator — notes: ${reviewNotes}`);
}

// ========== 2. noted cap (applied: false only) ==========
// Weak artifacts + high-risk → raw score already ≤ OUTCOME_CAP (69), so the
// high-risk floor records a note without applying. Keep tasksTotal < 5 so the
// review-coverage cap cannot fire an applied entry either.
const notedId = forgeNew('add-stripe-refund-auth', 'payment refunds behind an authorization gate');
patchSession(notedId, {
  resolvedPace: 'brisk',
  pace: 'brisk',
  pacePinned: true,
  tasksTotal: 2,
  tasksComplete: 0,
  // No evidence / verify — keep raw points low so high-risk is noted-only.
});
// Intentionally omit plantBaselineArtifacts — empty session stays ≤ 69.

const notedCard = scoreOf(notedId, { write: true });
if (notedCard.score > 69) {
  fail(`noted-cap: raw score ${notedCard.score} > 69 — high-risk would apply, not note`);
}
const notedHighRisk = (notedCard.caps ?? []).find(
  (c) => (typeof c === 'object' ? c.id === 'high-risk' : /high-risk/i.test(capText(c))),
);
if (!notedHighRisk || typeof notedHighRisk !== 'object') {
  fail(`noted-cap: expected structured high-risk note, got: ${JSON.stringify(notedCard.caps)}`);
}
if (notedHighRisk.applied !== false) {
  fail(`noted-cap: expected applied:false, got ${JSON.stringify(notedHighRisk)}`);
}
const notedApplied = (notedCard.caps ?? []).filter(
  (c) => typeof c === 'string' || (c != null && typeof c === 'object' && c.applied === true),
);
if (notedApplied.length > 0) {
  fail(`noted-cap: session must only have noted caps, also got applied: ${JSON.stringify(notedApplied)}`);
}

const notedFleet = fleetReport();
const notedRow = findFleetSession(notedFleet, notedId);
if (!notedRow) fail(`noted-cap: session ${notedId} missing from fleet report`);
if (notedRow.capped === true) {
  fail(`noted-cap: fleet marked session capped despite only applied:false notes`);
}

// ========== 3. applied cap ==========
const appliedId = forgeNew('add-stripe-refund-auth', 'payment refunds behind an authorization gate');
patchSession(appliedId, {
  resolvedPace: 'standard',
  pace: 'standard',
  pacePinned: true,
  tasksTotal: 6,
  tasksComplete: 6,
});
const appliedDir = path.join(PROJECT, '.forge', 'sessions', appliedId);
plantBaselineArtifacts(appliedDir);

const appliedCard = scoreOf(appliedId, { write: true });
const appliedHighRisk = (appliedCard.caps ?? []).find(
  (c) => typeof c === 'object' && c.id === 'high-risk',
);
if (!appliedHighRisk) {
  fail(`applied-cap: expected structured high-risk cap, got: ${JSON.stringify(appliedCard.caps)}`);
}
if (appliedHighRisk.applied !== true) {
  fail(`applied-cap: expected applied:true, got ${JSON.stringify(appliedHighRisk)}`);
}
if (appliedCard.score !== 69) {
  fail(`applied-cap: expected score 69, got ${appliedCard.score}`);
}

const appliedFleet = fleetReport();
const appliedRow = findFleetSession(appliedFleet, appliedId);
if (!appliedRow) fail(`applied-cap: session ${appliedId} missing from fleet report`);
if (appliedRow.capped !== true) {
  fail(`applied-cap: fleet did not mark session capped (got capped=${appliedRow.capped})`);
}

process.stdout.write('DENOM groups=1 noted-cap=ok applied-cap=ok\n');
fs.rmSync(SCRATCH, { recursive: true, force: true });
