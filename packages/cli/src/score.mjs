/**
 * Forge session scorecard — L2 measurement after (or before) phase done.
 *
 * Grades session *artifacts*, not the agent's self-report. L1 integrity is a
 * prerequisite signal inside the score; L3 golden/product outcomes stay
 * human/CI. See docs/usage.md § Session success.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from './lib.mjs';
import {
  JOBS_SIGNAL_RE,
  checkE2eGate,
  e2eDisabledReason,
  e2ePath,
  loadDeferrals,
  openDeferrals,
  resolveChangeDir,
  runIntegrityChecks,
  sessionJobsSignalText,
  spinePath,
  validateSpine,
} from './integrity.mjs';

/** Keep in sync with set-phase.mjs TASK_COUNT_ESCALATION_THRESHOLD. */
const TASK_COUNT_ESCALATION_THRESHOLD = 15;

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
 * @param {string} sessionDir
 */
function listTaskEvidence(sessionDir) {
  const tasksDir = path.join(sessionDir, 'tasks');
  if (!fs.existsSync(tasksDir)) return { taskDirs: 0, withEvidence: 0, exitNonZero: 0 };
  const entries = fs.readdirSync(tasksDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  let withEvidence = 0;
  let exitNonZero = 0;
  for (const e of entries) {
    const file = path.join(tasksDir, e.name, 'test-evidence.md');
    if (!fs.existsSync(file)) continue;
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
 * @param {string} sessionDir
 */
function reviewSelfCheckCount(sessionDir) {
  const tasksDir = path.join(sessionDir, 'tasks');
  if (!fs.existsSync(tasksDir)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(tasksDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    for (const name of ['task-review.md', 'group-review.md']) {
      const file = path.join(tasksDir, e.name, name);
      if (!fs.existsSync(file)) continue;
      const body = fs.readFileSync(file, 'utf8');
      if (/pace self-check|APPROVED \(pace/i.test(body)) n += 1;
    }
  }
  return n;
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
  if (/\bBLOCKED\b/.test(body)) {
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
  if (!fs.existsSync(spineFile)) {
    spineNotes.push('spine.json missing');
  } else {
    try {
      const doc = readJson(spineFile);
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
    session.pacePinned !== true
  ) {
    pacePts = 0;
    paceNotes.push(
      `resolvedPace=${resolved} with ${total} tasks — expected escalation to standard`,
    );
  } else if (session.paceEscalated) {
    paceNotes.push(`escalated: ${session.paceReason ?? 'task count'}`);
  } else {
    paceNotes.push(`resolvedPace=${resolved ?? 'unset'}`);
  }
  checks.push({ id: 'pace', label: 'Pace sanity', points: pacePts, max: 5, notes: paceNotes });

  // --- review depth soft signal (5) ---
  const selfChecks = reviewSelfCheckCount(sessionDir);
  let reviewPts = 5;
  /** @type {string[]} */
  const reviewNotes = [];
  if (selfChecks > 0 && (resolved === 'thorough' || total >= TASK_COUNT_ESCALATION_THRESHOLD)) {
    reviewPts = Math.max(0, 5 - Math.min(5, selfChecks));
    reviewNotes.push(`${selfChecks} pace self-check review(s) on a large/thorough session`);
  } else if (selfChecks > 0) {
    reviewNotes.push(`${selfChecks} pace self-check(s) — ok under brisk/standard mid-group`);
  } else {
    reviewNotes.push('no pace self-check markers found');
  }
  checks.push({
    id: 'reviews',
    label: 'Review depth signal',
    points: reviewPts,
    max: 5,
    notes: reviewNotes,
  });

  let score = checks.reduce((s, c) => s + c.points, 0);
  const maxScore = checks.reduce((s, c) => s + c.max, 0);
  /** @type {string[]} */
  const caps = [];

  if (isNonEmptyString(session.incompleteReason)) {
    const before = score;
    score = Math.min(score, 59);
    caps.push(
      `incompleteReason set ("${session.incompleteReason}") — score capped at 59 (was ${before})`,
    );
  }

  const grade = gradeForScore(score);
  const changeDir = resolveChangeDir({ cwd, session });

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
    for (const c of card.caps) lines.push(`- ${c}`);
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
  appendScorecardLedger(opts.sessionDir, card, opts.session);
  return { card, jsonPath, mdPath };
}
