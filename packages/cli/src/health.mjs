#!/usr/bin/env node
/**
 * Session health — a verdict, not a data dump.
 *
 * `forge status` printed every field a session had and said nothing about
 * whether the session was in trouble, so a session could sit at
 * `implement 27/32` with a red e2e run for 14 hours and look exactly like one
 * that was mid-stride. Health answers the one question the operator actually
 * asks: is this session fine, stopped, or broken?
 *
 * Cheap on purpose — file reads only, no subprocesses — because it runs on
 * every `forge status`, every reminder hook, and once per row in
 * `forge fleet list`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { e2ePath, e2eStepsHash, loadE2eResults } from './integrity.mjs';
import { hasBlockedMarker, readJson } from './lib.mjs';
import { isTerminalPhase } from './lib/fleet.mjs';
import { readPlanTaskProgress } from './plan-progress.mjs';

/** Hours of no session write after which an unfinished session reads as stopped. */
export const DEFAULT_IDLE_HOURS = 4;

const SEVERITY = { done: 0, healthy: 1, stale: 2, red: 3 };

/**
 * @param {number} ms
 * @returns {string}
 */
function humanDuration(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${Math.max(min, 1)}m`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The failing step of a red run, for a reason line that names the problem
 * instead of pointing at a file.
 *
 * @param {Record<string, any> | null} results
 */
function failedStepName(results) {
  if (!results || !Array.isArray(results.steps)) return null;
  const failed = results.steps.find((s) => s && s.ok === false);
  return failed?.name ?? null;
}

/**
 * @param {{ cwd?: string, sessionDir: string, session: Record<string, any>, now?: number, idleHours?: number }} opts
 * @returns {{ state: 'healthy'|'stale'|'red'|'done', reasons: string[], line: string }}
 */
export function sessionHealth(opts) {
  const cwd = opts.cwd ?? process.cwd();
  const { sessionDir, session } = opts;
  const now = opts.now ?? Date.now();
  const idleHours = Number.isFinite(opts.idleHours) ? Number(opts.idleHours) : DEFAULT_IDLE_HOURS;

  /** @type {string[]} */
  const reasons = [];
  let state = 'healthy';
  const escalate = (next) => {
    if (SEVERITY[next] > SEVERITY[state]) state = next;
  };

  if (isTerminalPhase(session.phase)) {
    return {
      state: 'done',
      reasons: [],
      line: `DONE — ${session.slug ?? session.id} (${session.phase})`,
    };
  }

  // --- executed product loop: the strongest signal we have on disk ---
  try {
    const results = loadE2eResults(sessionDir);
    if (results) {
      let currentHash = null;
      try {
        const doc = readJson(e2ePath({ cwd, session, sessionDir }));
        currentHash = e2eStepsHash(doc.steps);
      } catch {
        currentHash = null;
      }
      // A failed run outranks a stale one: staleness asks "does this proof
      // still describe the current steps", a failure says the loop is broken
      // either way.
      if (results.ok === false) {
        const step = failedStepName(results);
        const since = results.ranAt ? ` since ${results.ranAt}` : '';
        reasons.push(`e2e failing${since}${step ? ` at step "${step}"` : ''}`);
        escalate('red');
      } else if (currentHash && results.stepsHash !== currentHash) {
        reasons.push('e2e results are stale — e2e.json changed since the last run');
        escalate('stale');
      }
    }
  } catch {
    /* health must never throw — a broken artifact is the caller's problem */
  }

  // --- an explicit BLOCKED beats any inference we could make ---
  try {
    const verify = path.join(sessionDir, 'verify-evidence.md');
    if (fs.existsSync(verify) && hasBlockedMarker(fs.readFileSync(verify, 'utf8'))) {
      reasons.push('verify-evidence records BLOCKED — product loop not proven');
      escalate('red');
    }
  } catch {
    /* ignore */
  }

  // --- idle: nobody is driving this session ---
  // tasks.md checkboxes are what agents actually update; their mtime counts as
  // activity even when session.tasksComplete was never bumped.
  const planProgress = readPlanTaskProgress({ cwd, session });
  const updatedAt = new Date(session.updatedAt ?? session.createdAt ?? NaN).getTime();
  const activityAt = Math.max(
    Number.isNaN(updatedAt) ? 0 : updatedAt,
    planProgress?.mtimeMs ?? 0,
  );
  if (activityAt > 0) {
    const idleMs = now - activityAt;
    if (idleMs > idleHours * 3600 * 1000) {
      const complete = planProgress?.complete ?? session.tasksComplete ?? 0;
      const total = planProgress?.total ?? session.tasksTotal ?? 0;
      const where = `${session.phase ?? 'unknown'}${
        Number(total) > 0 ? ` ${complete}/${total}` : ''
      }`;
      reasons.push(`idle ${humanDuration(idleMs)} at ${where}`);
      escalate('stale');
    }
  }

  const label = state.toUpperCase();
  const line = reasons.length ? `${label} — ${reasons.join('; ')}` : `${label} — ${session.phase}`;
  return { state, reasons, line };
}

/** Short cell for table renderers (`forge fleet list`). */
export function healthCell(state) {
  switch (state) {
    case 'red':
      return 'RED';
    case 'stale':
      return 'STALE';
    case 'done':
      return 'done';
    default:
      return 'ok';
  }
}
