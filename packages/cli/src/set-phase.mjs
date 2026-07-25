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
import { briefProblem, checkBrief } from './brief.mjs';
import { collectPlanFacts, suggestPaceFromPlan } from './plan-facts.mjs';
import { reviewCensus } from './review-census.mjs';
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
    'Usage: forge phase <phase> [--plan-type openspec|specs|throwaway|direct] [--openspec <change>] [--tasks-total N] [--tasks-complete N] [--subagents N] [--allow-incomplete "<reason>"] [--final-review-waived "<reason>"] [--session <id>]\n',
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
let finalReviewWaived = null;

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
  } else if (flag === '--final-review-waived' && next) {
    finalReviewWaived = next;
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

/**
 * Re-resolve `auto` pace from the plan on the way into implement.
 *
 * At `forge new` the only signal is a free-text slug, and classifying that
 * returned `standard` on every real session (three of them via "unrecognized
 * scope — failing closed"). By this point the plan exists: task count, group
 * count, capabilities, spine rows and whether anything touches money/auth are
 * all facts, so decide from those instead.
 */
function maybeResolvePaceFromPlan() {
  if (phase !== 'implement') return;
  if (session.pace !== 'auto' || session.pacePinned === true) return;
  try {
    const facts = collectPlanFacts({ session });
    if (!facts.readable) return;
    const suggested = suggestPaceFromPlan(facts);
    if (suggested.pace === session.resolvedPace) return;
    session.paceResolvedFrom = 'plan';
    session.resolvedPace = suggested.pace;
    session.paceReason = `plan: ${suggested.reason}`;
    process.stderr.write(`[forge] Pace auto → ${suggested.pace} (${suggested.reason})\n`);
  } catch (err) {
    // Never block a phase transition — but say so, because a silent catch
    // here would hide a wiring bug as "pace just didn't change".
    process.stderr.write(
      `[forge] Warning: could not resolve pace from the plan: ${err instanceof Error ? err.message : err}\n`,
    );
  }
}

maybeResolvePaceFromPlan();
maybeEscalatePaceForTaskCount();

/**
 * Hard gate: implementation may not start until the operator brief exists and
 * matches the current specs — the plan-approval checkpoint is only as strong
 * as the human's comprehension of it. `--allow-incomplete "<reason>"` records
 * an honest skip.
 */
function enforceBriefGate() {
  if (phase !== 'implement') return;
  const result = checkBrief({ session });
  if (result.ok) {
    delete session.briefSkipped;
    return;
  }
  if (allowIncomplete) {
    session.briefSkipped = allowIncomplete;
    return;
  }
  process.stderr.write(
    `Cannot enter phase "implement":\n  - ${briefProblem(result)}\n` +
      'Write the brief (see forge references/operator-brief.md), forge brief stamp, ' +
      'or pass --allow-incomplete "<reason>".\n',
  );
  process.exit(1);
}

enforceBriefGate();

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

/**
 * Hard floor: a high-risk change gets an independent final review.
 *
 * This was a paragraph in the skill and a line in three analysis reports, and
 * it was skipped anyway — the session that most needed it recorded "subagent
 * dispatch was declined twice" in review prose that no gate could see, then
 * scored 100/100. A rule that matters has to be a gate; the waiver is a field
 * so it survives session cleanup and lands in the ledgers.
 */
function enforceFinalReviewFloor() {
  if (phase !== 'done' && phase !== 'finish') return;
  if (finalReviewWaived) {
    session.finalReviewWaived = finalReviewWaived;
    return;
  }
  if (allowIncomplete) return; // already an explicit, recorded escape

  let facts;
  try {
    facts = collectPlanFacts({ session });
  } catch {
    return; // cannot judge risk — do not invent a refusal
  }
  if (!facts.highRisk) {
    delete session.finalReviewWaived;
    return;
  }
  if (reviewCensus(dir).finalReview === 'independent') {
    delete session.finalReviewWaived;
    return;
  }

  process.stderr.write(
    `Cannot enter phase "${phase}": this change touches money/auth/contracts/migrations, ` +
      'and its final review is missing or self-authored.\n' +
      '  - Dispatch an independent final reviewer (forge resolve-model --tier capable), then save reviews/final-review.md\n' +
      '  - Or record the refusal: --final-review-waived "<reason>" (kept on the session and in .forge/sessions.jsonl)\n',
  );
  process.exit(1);
}

enforceFinalReviewFloor();
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
