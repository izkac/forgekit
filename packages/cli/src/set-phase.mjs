#!/usr/bin/env node
/**
 * Update Forge session phase and optional fields.
 *
 * Usage:
 *   forge phase <phase> [--plan-type openspec|specs|throwaway|direct] [--openspec <change>] [--tasks-total N] [--tasks-complete N] [--subagents N] [--allow-incomplete "<reason>"]
 *
 * `--openspec <change>` names the change for both engines (openspec/changes/<change>
 * or specs/changes/<change>).
 *
 * `finish` / `done` refuse unless verify-evidence.md exists and all tasks are
 * complete, unless `--allow-incomplete "<reason>"` is provided.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadSession, readActive, saveSession } from './lib.mjs';
import { runIntegrityChecks } from './integrity.mjs';
import { writeSessionScorecard } from './score.mjs';

const VALID_PHASES = new Set([
  'triage',
  'brainstorm',
  'plan',
  'implement',
  'verify',
  'review',
  'finish',
  'done',
  'skipped',
]);

/** Escalate auto-resolved brisk/lite when the plan has at least this many tasks. */
export const TASK_COUNT_ESCALATION_THRESHOLD = 15;

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help') {
  process.stderr.write(
    'Usage: forge phase <phase> [--plan-type openspec|specs|throwaway|direct] [--openspec <change>] [--tasks-total N] [--tasks-complete N] [--subagents N] [--allow-incomplete "<reason>"] [--session <id>]\n',
  );
  process.exit(1);
}

const phase = args[0];
if (!VALID_PHASES.has(phase)) {
  process.stderr.write(`Invalid phase: ${phase}\n`);
  process.exit(1);
}

let sessionId = null;
let planType = null;
let openspecChange = null;
let tasksTotal = null;
let tasksComplete = null;
let subagentsDispatched = null;
let allowIncomplete = null;

for (let i = 1; i < args.length; i += 1) {
  const flag = args[i];
  const next = args[i + 1];
  if (flag === '--session' && next) {
    sessionId = next;
    i += 1;
  } else if (flag === '--plan-type' && next) {
    planType = next;
    i += 1;
  } else if (flag === '--openspec' && next) {
    openspecChange = next;
    i += 1;
  } else if (flag === '--tasks-total' && next) {
    tasksTotal = Number(next);
    i += 1;
  } else if (flag === '--tasks-complete' && next) {
    tasksComplete = Number(next);
    i += 1;
  } else if (flag === '--subagents' && next) {
    subagentsDispatched = Number(next);
    i += 1;
  } else if (flag === '--allow-incomplete' && next) {
    allowIncomplete = next;
    i += 1;
  }
}

if (!sessionId) {
  const active = readActive();
  sessionId = active?.sessionId;
}
if (!sessionId) {
  process.stderr.write('No active session. Run forge:new first.\n');
  process.exit(1);
}

const { dir, session } = loadSession(sessionId);
session.phase = phase;
if (planType) session.planType = planType;
if (openspecChange !== null) session.openspecChange = openspecChange;
if (tasksTotal !== null) session.tasksTotal = tasksTotal;
if (tasksComplete !== null) session.tasksComplete = tasksComplete;
if (subagentsDispatched !== null) session.subagentsDispatched = subagentsDispatched;

/**
 * Escalate under-scoped auto pace when the plan is large.
 * Only when pace is not user-pinned and current resolved pace is brisk/lite.
 */
function maybeEscalatePaceForTaskCount() {
  const total = Number(session.tasksTotal) || 0;
  if (total < TASK_COUNT_ESCALATION_THRESHOLD) return;
  if (session.pacePinned === true) return;
  const resolved = session.resolvedPace;
  if (resolved !== 'brisk' && resolved !== 'lite') return;
  session.resolvedPace = 'standard';
  session.paceReason = `escalated: ${total} tasks`;
  session.paceEscalated = true;
}

maybeEscalatePaceForTaskCount();

/**
 * Refuse finish/done without verify evidence, full task completion, and a
 * clean integrity check (spine matrix, deferrals, product-loop evidence) —
 * unless --allow-incomplete records an honest reason.
 */
function enforceDoneGate() {
  if (phase !== 'done' && phase !== 'finish') return;

  const total = Number(session.tasksTotal) || 0;
  const complete = Number(session.tasksComplete) || 0;
  const evidencePath = path.join(dir, 'verify-evidence.md');
  const hasEvidence = fs.existsSync(evidencePath);
  const tasksDone = total === 0 || complete === total;

  const problems = [];
  if (!hasEvidence) problems.push('missing verify-evidence.md');
  if (!tasksDone) problems.push(`tasks incomplete (${complete}/${total})`);

  const integrity = runIntegrityChecks({ sessionDir: dir, session });
  problems.push(...integrity.problems);

  if (problems.length === 0) {
    delete session.incompleteReason;
    return;
  }

  if (allowIncomplete) {
    session.incompleteReason = allowIncomplete;
    return;
  }

  process.stderr.write(
    `Cannot enter phase "${phase}":\n${problems.map((p) => `  - ${p}`).join('\n')}\n` +
      `Fix the above (forge integrity-check to re-run), or pass --allow-incomplete "<reason>".\n`,
  );
  process.exit(1);
}

enforceDoneGate();

// L2 scorecard on finish/done — always write so sessions leave a measurable trail
if (phase === 'done' || phase === 'finish') {
  try {
    const { card, mdPath } = writeSessionScorecard({ sessionDir: dir, session });
    session.score = card.score;
    session.scoreGrade = card.grade;
    process.stderr.write(
      `[forge] Session score: ${card.score}/${card.maxScore} grade ${card.grade} → ${mdPath}\n`,
    );
  } catch (err) {
    process.stderr.write(
      `[forge] Warning: could not write scorecard: ${err instanceof Error ? err.message : err}\n`,
    );
  }
}

saveSession(dir, session);
process.stdout.write(JSON.stringify({ sessionId, phase: session.phase, session }, null, 2));
process.stdout.write('\n');
