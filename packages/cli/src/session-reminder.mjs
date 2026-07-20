#!/usr/bin/env node
/**
 * Build Forge session reminders for agent hooks.
 *
 * Usage:
 *   forge reminder --format cursor
 *   forge reminder --format claude-session-start
 *   forge reminder --format plain
 */

import { FORGE_DIR, loadSession, readActive } from './lib.mjs';
import { drainInbox } from './lib/fleet.mjs';
import { resolveEffectivePreferences } from './preferences.mjs';

function getActiveSessionInfo() {
  const active = readActive();
  if (!active?.sessionId) return null;
  try {
    const { dir, session } = loadSession(active.sessionId);
    return { active, dir, session };
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, unknown>} session
 */
export function formatPaceLine(session) {
  try {
    const eff = resolveEffectivePreferences({
      forgeDir: FORGE_DIR,
      session,
      signalText:
        (typeof session.paceSignal === 'string' && session.paceSignal) ||
        (typeof session.slug === 'string' && session.slug) ||
        '',
    });
    const requested = eff.requestedPace;
    const resolved = eff.resolvedPace;
    if (requested === 'auto') {
      return `Pace: auto → ${resolved} (${eff.paceReason})`;
    }
    return `Pace: ${resolved}`;
  } catch {
    const requested = session.pace ?? 'auto';
    const resolved = session.resolvedPace;
    if (resolved) return `Pace: ${requested} → ${resolved}`;
    return `Pace: ${requested}`;
  }
}

export const OPENSPEC_PLAN_REMINDER =
  'Planning: Forge always uses OpenSpec. After brainstorm approval, run /opsx:propose (openspec-propose). Do not ask for a plan mode. See forge references/plan-routing.md.';

/** @deprecated use OPENSPEC_PLAN_REMINDER */
export const PLAN_MODE_PROMPT_REMINDER = OPENSPEC_PLAN_REMINDER;

export function needsOpenSpecPlan(session) {
  return (
    !session.planType &&
    (session.phase === 'brainstorm' || session.phase === 'plan')
  );
}

/** @deprecated use needsOpenSpecPlan */
export const needsPlanModePrompt = needsOpenSpecPlan;

export const RUNTIME_INTEGRITY_REMINDER =
  'Integrity: spine.json mandatory every change (rows or notApplicable); no stubs/false success; specs beat task wording; product-loop when spine has rows; defer wiring only via `forge defer` — `forge phase done` runs `forge integrity-check` (forge references/runtime-integrity.md).';

export function buildForgeMessage(info) {
  const { session } = info;
  const lines = [];
  lines.push(`[forge] Active Forge session: ${session.id}`);
  lines.push(
    `Phase: ${session.phase} | Plan: ${session.planType ?? 'pending'}${
      session.openspecChange ? ` (${session.openspecChange})` : ''
    }`,
  );
  lines.push(formatPaceLine(session));
  if (session.tasksTotal > 0) {
    lines.push(`Tasks: ${session.tasksComplete}/${session.tasksTotal}`);
  }
  if (needsOpenSpecPlan(session)) {
    lines.push(OPENSPEC_PLAN_REMINDER);
  }
  lines.push(RUNTIME_INTEGRITY_REMINDER);
  lines.push('Resume: invoke the forge skill for the current phase.');
  lines.push('Honor pace: see forge references/pace.md (`forge prefs`).');
  lines.push('Skip Forge for this task only: /forge:skip');
  lines.push('Guide: Forge skill + docs/forge.md (under the installed forge skill)');
  return lines.join('\n');
}

export function buildForgePromptMessage(info, prompt) {
  const base = buildForgeMessage(info);
  const trimmed = (prompt || '').trim();
  if (/^\/forge:skip\b/i.test(trimmed)) {
    return `${base}\n\nUser invoked /forge:skip — execute directly; do not start brainstorm/plan.`;
  }
  if (/^\/forge:status\b/i.test(trimmed)) {
    return `${base}\n\nRun: forge status — then summarize for the user.`;
  }
  if (/^\/forge:plan\b/i.test(trimmed)) {
    return `${base}\n\nPlan phase: ${OPENSPEC_PLAN_REMINDER}`;
  }
  if (/^\/forge:brainstorm\b/i.test(trimmed)) {
    return `${base}\n\nBrainstorm terminal state: proceed to OpenSpec propose — do not implement until artefacts are approved.`;
  }
  return `${base}\n\nUser invoked Forge — follow forge skill from phase "${info.session.phase}".`;
}

function emitCursor(message) {
  const payload = JSON.stringify({ agent_message: message });
  process.stdout.write(`${payload}\n`);
}

function emitClaudeSessionStart(message) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `<system-reminder>\n${message}\n</system-reminder>`,
    },
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function emitPlain(message) {
  process.stdout.write(`${message}\n`);
}

const args = process.argv.slice(2);
let format = 'plain';
let prompt = '';

for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--format' && args[i + 1]) {
    format = args[i + 1];
    i += 1;
  } else if (args[i] === '--prompt' && args[i + 1]) {
    prompt = args[i + 1];
    i += 1;
  }
}

const info = getActiveSessionInfo();
if (!info) {
  process.exit(0);
}

let message = prompt
  ? buildForgePromptMessage(info, prompt)
  : buildForgeMessage(info);

// Deliver queued `forge fleet send` messages exactly once (drain moves them
// to inbox/delivered/). This is the fleet command bus: control terminal →
// inbox file → injected into the agent's next turn via this hook.
const fleetMessages = drainInbox(info.dir);
if (fleetMessages.length > 0) {
  message += `\n\nFleet messages from the control terminal — acknowledge and act on these first:\n${fleetMessages
    .map((m) => `- ${m.text}`)
    .join('\n')}`;
}

switch (format) {
  case 'cursor':
    emitCursor(message);
    break;
  case 'claude-session-start':
    emitClaudeSessionStart(message);
    break;
  case 'plain':
    emitPlain(message);
    break;
  default:
    process.stderr.write(`Unknown format: ${format}\n`);
    process.exit(1);
}
