#!/usr/bin/env node
/**
 * Update Forge session phase and optional fields.
 *
 * Usage:
 *   forge phase <phase> [--plan-type openspec|specs|throwaway|direct] [--openspec <change>] [--tasks-total N] [--tasks-complete N] [--subagents N]
 *
 * `--openspec <change>` names the change for both engines (openspec/changes/<change>
 * or specs/changes/<change>).
 */

import { loadSession, readActive, saveSession } from './lib.mjs';

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

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help') {
  process.stderr.write(
    'Usage: forge phase <phase> [--plan-type openspec|specs|throwaway|direct] [--openspec <change>] [--tasks-total N] [--tasks-complete N] [--subagents N] [--session <id>]\n',
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

saveSession(dir, session);
process.stdout.write(JSON.stringify({ sessionId, phase: session.phase, session }, null, 2));
process.stdout.write('\n');
