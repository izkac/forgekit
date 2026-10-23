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
 * Tier-3 verdict from `verify-runs.jsonl`, judged by the last `full` stamp
 * (a stamp with no `scope` field is a legacy full run). Returns null when no
 * full stamp exists — scoped stamps alone are not tier 3.
 *
 * Fields: `ok`/`exit`/`command`/`at` describe the last full stamp, unchanged.
 * `scope` is always 'full'. When that stamp is red and the last `failed-only`
 * stamp appended after it is green, `ok` is true, `via` is 'failed-only' and
 * `rescue` is `{ command, at }` of that re-run (`exit` still the full run's
 * exit). `fix` and `group` stamps never change the verdict. `counts` is the
 * number of stamps per scope across the whole file.
 *
 * @param {string} sessionDir
 */
function lastTier3(sessionDir) {
  const file = path.join(sessionDir, 'verify-runs.jsonl');
  if (!fs.existsSync(file)) return null;
  /** @type {Array<Record<string, any> & { scope: string }>} */
  const stamps = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line);
      stamps.push({ ...s, scope: s.scope ?? 'full' });
    } catch {
      // skip a torn line
    }
  }
  const counts = { full: 0, 'failed-only': 0, fix: 0, group: 0 };
  for (const s of stamps) if (s.scope in counts) counts[s.scope] += 1;
  const fullAt = stamps.findLastIndex((s) => s.scope === 'full');
  if (fullAt === -1) return null;
  const full = stamps[fullAt];
  const verdict = {
    ok: full.ok === true,
    exit: full.exit ?? null,
    command: full.command ?? '',
    at: full.startedAt ?? null,
    scope: 'full',
    counts,
  };
  if (verdict.ok) return verdict;
  const retry = stamps.slice(fullAt + 1).findLast((s) => s.scope === 'failed-only');
  if (retry?.ok !== true) return verdict;
  return {
    ...verdict,
    ok: true,
    via: 'failed-only',
    rescue: { command: retry.command ?? '', at: retry.startedAt ?? null },
  };
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
  const t3 = p.tier3;
  const tier3 = !t3
    ? 'tier3 not stamped'
    : t3.via
      ? `tier3 ok via ${t3.via} re-run (full run exit ${t3.exit ?? 'null'})`
      : t3.ok
        ? 'tier3 exit 0'
        : `tier3 exit ${t3.exit ?? 'null'}`;
  const kf = p.knownFalse > 0 ? `; known-false ${p.knownFalse} (forge refute list)` : '';
  return (
    `Proven (executed): tasks ${p.tasks.ok}/${p.tasks.total} evidence ok; ${tier3}; e2e ${p.e2e.state}${kf}. ` +
    'Everything else in session files is model-authored — UNVERIFIED until a gate re-checks it.'
  );
}
