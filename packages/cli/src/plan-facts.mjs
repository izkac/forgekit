#!/usr/bin/env node
/**
 * Pace from the plan, not from the slug.
 *
 * `pace: auto` classified a free-text signal written at session creation
 * ("Phase 1: VFS + listing engine, headless…") with a keyword regex. Across
 * five real sessions it returned `standard` every time, three of them via
 * "unrecognized scope — failing closed" — a constant dressed as a decision,
 * while `brisk` and `lite` were documented and never selected.
 *
 * By the end of plan the facts exist: how many tasks, how many groups, how
 * many capabilities, whether the spine has wired rows, and whether anything in
 * the change touches money/auth/contracts. This resolves from those.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveChangeDir } from './integrity.mjs';
import { isHighRiskText } from './preferences.mjs';

/** A tasks.md checkbox line. */
const TASK_LINE_RE = /^\s*-\s*\[[ xX]\]\s+/;
/** Numbered task-group heading: `## 1. …` or `## 2) …`. */
const GROUP_RE = /^##\s+\d+[.)]\s+\S/;
/** Fenced code block (opening fence through closing fence, inclusive). */
const FENCE_RE = /^```[\s\S]*?^```/gm;

/**
 * @param {string} file
 * @returns {string}
 */
function readOrEmpty(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Strip markdown fenced code blocks so sample headings/tasks do not count.
 * @param {string} body
 * @returns {string}
 */
function stripFencedBlocks(body) {
  return body.replace(FENCE_RE, '');
}

/**
 * Measure the planned change.
 *
 * @param {{ cwd?: string, session: Record<string, any> }} opts
 * @returns {{ readable: boolean, tasks: number, groups: number, spineRows: number,
 *            spineNotApplicable: boolean, capabilities: number, highRisk: boolean, changeDir: string | null }}
 */
export function collectPlanFacts(opts) {
  const cwd = opts.cwd ?? process.cwd();
  const changeDir = resolveChangeDir({ cwd, session: opts.session });
  const facts = {
    readable: false,
    tasks: 0,
    groups: 0,
    spineRows: 0,
    spineNotApplicable: false,
    capabilities: 0,
    highRisk: false,
    changeDir,
  };
  if (!changeDir || !fs.existsSync(changeDir)) return facts;

  const tasksBody = readOrEmpty(path.join(changeDir, 'tasks.md'));
  const proposalBody = readOrEmpty(path.join(changeDir, 'proposal.md'));
  const designBody = readOrEmpty(path.join(changeDir, 'design.md'));
  facts.readable = Boolean(tasksBody || proposalBody);

  for (const line of stripFencedBlocks(tasksBody).split('\n')) {
    if (TASK_LINE_RE.test(line)) facts.tasks += 1;
    else if (GROUP_RE.test(line)) facts.groups += 1;
  }

  let spineBody = '';
  try {
    const spineFile = path.join(changeDir, 'spine.json');
    if (fs.existsSync(spineFile)) {
      spineBody = fs.readFileSync(spineFile, 'utf8');
      const doc = JSON.parse(spineBody);
      facts.spineRows = Array.isArray(doc.rows) ? doc.rows.length : 0;
      facts.spineNotApplicable = typeof doc.notApplicable === 'string' && doc.notApplicable.trim() !== '';
    }
  } catch {
    /* an unreadable spine contributes nothing but must not throw */
  }

  const capsDir = path.join(changeDir, 'specs');
  try {
    facts.capabilities = fs
      .readdirSync(capsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory()).length;
  } catch {
    facts.capabilities = 0;
  }

  // Risk read across everything the plan says, including the spine — the same
  // fail-closed rule the scorer uses.
  facts.highRisk = isHighRiskText(
    [proposalBody, designBody, tasksBody, spineBody, opts.session?.paceSignal, opts.session?.slug]
      .filter(Boolean)
      .join(' '),
  );
  return facts;
}

/** Tasks at or above this count mean a multi-surface change. */
const STANDARD_TASKS = 15;
/** Below this, with nothing else going on, the ceremony is not worth it. */
const BRISK_TASKS = 6;

/**
 * @param {ReturnType<typeof collectPlanFacts>} facts
 * @returns {{ pace: string, reason: string }}
 */
export function suggestPaceFromPlan(facts) {
  if (!facts || !facts.readable) {
    return { pace: 'standard', reason: 'could not read the plan — failing closed to standard' };
  }
  if (facts.highRisk) {
    return {
      pace: 'thorough',
      reason: 'plan touches money/auth/contracts/migrations — hard floor is thorough',
    };
  }
  if (facts.tasks >= STANDARD_TASKS) {
    return { pace: 'standard', reason: `${facts.tasks} tasks across ${facts.groups} group(s)` };
  }
  if (facts.spineRows >= 2) {
    return {
      pace: 'standard',
      reason: `${facts.spineRows} spine rows — wired capabilities need per-group review`,
    };
  }
  if (facts.tasks > 0 && facts.tasks < BRISK_TASKS && facts.spineRows === 0 && facts.capabilities <= 1) {
    return {
      pace: 'brisk',
      reason: `${facts.tasks} tasks, single capability, no wired spine rows`,
    };
  }
  return {
    pace: 'standard',
    reason: `${facts.tasks} tasks, ${facts.spineRows} spine row(s) — default`,
  };
}
