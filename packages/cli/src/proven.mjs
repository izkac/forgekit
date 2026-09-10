#!/usr/bin/env node
/**
 * Proven vs. unverified — what a resumed session may treat as established.
 *
 * A session directory holds two kinds of text and nothing told them apart: the
 * facts a tool produced by executing something (tdd stamps, e2e results, gate
 * results, executed evidence) and the prose a model wrote about the work
 * (review verdicts, verify narrative, ticked checkboxes, briefs). After a
 * compaction or a fresh context the second kind reads exactly like the first,
 * and a guess can ride into the next context as a fact. This block is the
 * separation: `proven` is computed from executed artifacts only, and
 * `unverified` names the model-authored files by name so the resume path can
 * label them instead of trusting them.
 *
 * Library only; `forge status` and the session reminder print it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { checkE2eGate, e2eDisabledReason, e2ePath, e2eSkipState } from './integrity.mjs';
import { taskFacts } from './review-precheck.mjs';
import { readRefutations } from './refute.mjs';

/** Model-authored session files — data, never established fact. */
export const UNVERIFIED_SOURCES = Object.freeze([
  'tasks.md checkboxes',
  'task-review.md / group-review.md verdicts',
  'verify-evidence.md prose (loop narrative, REQ→caller table)',
  'brainstorm notes and decisions',
  'briefs and implementer reports',
]);

/**
 * Last tier-3 stamp `forge evidence --tier3` wrote, or null.
 * @param {string} sessionDir
 */
function lastTier3(sessionDir) {
  const file = path.join(sessionDir, 'verify-runs.jsonl');
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const s = JSON.parse(lines[i]);
      return { ok: s.ok === true, exit: s.exit ?? null, command: s.command ?? '', at: s.startedAt ?? null };
    } catch {
      // skip a torn line
    }
  }
  return null;
}

/**
 * @param {{ cwd?: string, sessionDir: string, session: Record<string, any> }} opts
 * @returns {{ state: string, detail: string | null }}
 */
function e2eState(opts) {
  try {
    const disabled = e2eDisabledReason(opts.cwd ?? process.cwd());
    if (disabled) return { state: 'disabled', detail: disabled };
    const skip = e2eSkipState(opts);
    if (skip.skipped) return { state: 'skipped', detail: skip.reason ?? null };
    const gate = checkE2eGate({ e2eFile: e2ePath(opts), sessionDir: opts.sessionDir });
    if (gate.notApplicable) return { state: 'n/a', detail: null };
    if (gate.problems.length === 0) return { state: 'green', detail: null };
    return { state: 'not green', detail: gate.problems[0] };
  } catch (err) {
    return { state: 'unknown', detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * @param {{ cwd?: string, sessionDir: string, session: Record<string, any> }} opts
 */
export function provenFacts(opts) {
  const { sessionDir, session } = opts;
  let tasks = [];
  try {
    tasks = taskFacts(sessionDir, session?.features?.tddEvidence === true);
  } catch {
    tasks = [];
  }
  return {
    tasks: { ok: tasks.filter((t) => t.ok).length, total: tasks.length, rows: tasks },
    tier3: lastTier3(sessionDir),
    e2e: e2eState(opts),
    knownFalse: readRefutations(sessionDir).length,
    unverified: [...UNVERIFIED_SOURCES],
  };
}

/**
 * One line for the resume reminder.
 * @param {ReturnType<typeof provenFacts>} p
 */
export function provenLine(p) {
  const tier3 = p.tier3 ? (p.tier3.ok ? 'tier3 exit 0' : `tier3 exit ${p.tier3.exit ?? 'null'}`) : 'tier3 not stamped';
  const kf = p.knownFalse > 0 ? `; known-false ${p.knownFalse} (forge refute list)` : '';
  return (
    `Proven (executed): tasks ${p.tasks.ok}/${p.tasks.total} evidence ok; ${tier3}; e2e ${p.e2e.state}${kf}. ` +
    'Everything else in session files is model-authored — UNVERIFIED until a gate re-checks it.'
  );
}
