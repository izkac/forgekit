/**
 * The dispatch ledger: one line per subagent dispatch the model policy saw.
 *
 * `forge resolve-model` is a contract the coordinator is asked to honour, and
 * measured in the field it gets skipped — the coordinator passes a tier model
 * it remembers instead, and `.forge/models.local.json` has no observable
 * effect. `forge enforce-model` closes that loop from the host side; this
 * records what it decided, so "how often was the resolver skipped" becomes a
 * number instead of an impression.
 *
 * Lines are written by the PreToolUse hook and read by `metrics/collect.mjs`,
 * which is exactly why the format lives here and not in either of them: a
 * writer and a reader that each carry their own idea of the row shape will
 * eventually disagree, and the disagreement would look like missing dispatches.
 *
 * Nothing here throws, and nothing here is on the dispatch's critical path in
 * any sense that matters: the hook writes its decision first and logs second,
 * because a telemetry file that cannot be written must cost a measurement,
 * never a subagent.
 *
 * Rows carry counts and identifiers only — tool name, agent type, model slugs,
 * a decision and a short reason code. The dispatch `prompt` and `description`
 * are never read.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadProjectConfig } from '../config.mjs';

/** Subagent dispatches a plan may use before `forge phase implement` warns. */
export const DEFAULT_DISPATCH_BUDGET = 15;

/**
 * `budget.subagents` from `.forge/config.json`, or the default when it is
 * absent or not a positive integer — a typo must not turn the warning off.
 *
 * @param {string} [cwd]
 * @returns {number}
 */
export function resolveDispatchBudget(cwd = process.cwd()) {
  const value = /** @type {any} */ (loadProjectConfig(cwd))?.budget?.subagents;
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_DISPATCH_BUDGET;
}

/** A session that dispatched nothing has zero of each — not "no answer". */
export const EMPTY_DISPATCHES = Object.freeze({
  total: 0,
  allowed: 0,
  rewritten: 0,
  denied: 0,
  skipped: 0,
});

/** @type {Record<string, 'allowed' | 'rewritten' | 'denied'>} */
const BUCKET = { allow: 'allowed', rewrite: 'rewritten', deny: 'denied' };

/**
 * @param {{ forgeDir?: string, cwd?: string }} opts
 * @returns {string}
 */
function resolveForgeDir(opts) {
  if (typeof opts.forgeDir === 'string' && opts.forgeDir) return opts.forgeDir;
  return path.join(opts.cwd ?? process.cwd(), '.forge');
}

/**
 * The active session's directory, or null when there is nothing to log to.
 *
 * A missing `active.json` is the ordinary case: the hook fires on every
 * dispatch in every project, and most of them are not running Forge. A pointer
 * to a directory that no longer exists is treated the same way rather than
 * recreated — `forge cleanup` deleting a session is not an invitation to write
 * a new one.
 *
 * @param {string} forgeDir
 * @returns {string | null}
 */
function activeSessionDir(forgeDir) {
  try {
    const active = JSON.parse(fs.readFileSync(path.join(forgeDir, 'active.json'), 'utf8'));
    const sessionId = active?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) return null;
    const dir = path.join(forgeDir, 'sessions', sessionId);
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/** Host conversation ids a session is bound to (`session.host.sessionIds`), or [] when unbound/unreadable. */
function boundHostIds(sessionDir) {
  try {
    const ids = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'))?.host?.sessionIds;
    return Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const FINISHED = new Set(['done', 'skipped']);

/**
 * F18: the session a dispatch belongs to. The active pointer is shared by every conversation
 * working in the checkout, so with the host conversation id: the active session when it is bound
 * to that conversation or to none (the old behavior), else an unfinished session bound to it,
 * else nobody — a dispatch credited to another conversation's session would inflate its count.
 *
 * @param {string} forgeDir
 * @param {string | null | undefined} hostSessionId
 * @returns {string | null}
 */
function dispatchSessionDir(forgeDir, hostSessionId) {
  const active = activeSessionDir(forgeDir);
  if (!hostSessionId) return active;
  if (active) {
    const ids = boundHostIds(active);
    if (ids.length === 0 || ids.includes(hostSessionId)) return active;
  }
  try {
    for (const e of fs.readdirSync(path.join(forgeDir, 'sessions'), { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = path.join(forgeDir, 'sessions', e.name);
      let phase = null;
      try {
        phase = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'))?.phase ?? null;
      } catch {
        continue;
      }
      if (!FINISHED.has(phase) && boundHostIds(dir).includes(hostSessionId)) return dir;
    }
  } catch {
    // no sessions dir — nothing to credit
  }
  return null;
}

/**
 * Record one dispatch decision against the active Forge session.
 *
 * @param {{ tool?: string | null, agentType?: string | null,
 *   modelRequested?: string | null, modelResolved?: string | null,
 *   decision?: string, reason?: string | null, toolUseId?: string | null }} row
 * @param {{ forgeDir?: string, cwd?: string, now?: () => Date, hostSessionId?: string | null }} [opts]
 *   `hostSessionId` — the host conversation that made the dispatch (the hook input's `session_id`);
 *   it picks the Forge session bound to that conversation (F18).
 * @returns {boolean} whether a line was written — false is a normal outcome
 */
export function appendDispatch(row, opts = {}) {
  try {
    if (!row || typeof row !== 'object') return false;
    const dir = dispatchSessionDir(resolveForgeDir(opts ?? {}), opts?.hostSessionId);
    if (!dir) return false;

    const now = typeof opts.now === 'function' ? opts.now() : new Date();
    /** @type {Record<string, any>} */
    const entry = {
      ts: new Date(now).toISOString(),
      tool: row.tool ?? null,
      agentType: row.agentType ?? null,
      modelRequested: row.modelRequested ?? null,
      modelResolved: row.modelResolved ?? null,
      decision: row.decision ?? null,
      reason: row.reason ?? null,
    };
    // Present only when the host gave us one: a row carrying it can be joined
    // to a subagent sidecar record, and a null would claim otherwise.
    if (typeof row.toolUseId === 'string' && row.toolUseId) entry.toolUseId = row.toolUseId;

    fs.appendFileSync(path.join(dir, 'dispatches.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
    return true;
  } catch {
    return false; // advisory — a hook must never fail over its own bookkeeping
  }
}

/**
 * Every dispatch row a session recorded, skipping any that did not survive.
 *
 * @param {string | null | undefined} sessionDir
 * @returns {Record<string, any>[]}
 */
export function readDispatches(sessionDir) {
  return readDispatchesChecked(sessionDir).rows;
}

/**
 * `readDispatches` plus whether the answer can be trusted as a count.
 *
 * `readDispatches` folds "no log yet" and "log we could not read" into the same
 * empty list, which is right for metrics (skip what you cannot use) and wrong
 * for a budget: a missing log is a genuine zero dispatches, an unreadable or
 * torn one is an unknown, and showing it as 0 would hide an overspend.
 * `readable` is false for any read failure other than the file not existing and
 * for any line that is not JSON; `rows` still holds every line that parsed.
 *
 * @param {string | null | undefined} sessionDir
 * @returns {{ rows: Record<string, any>[], readable: boolean }}
 */
export function readDispatchesChecked(sessionDir) {
  if (typeof sessionDir !== 'string' || !sessionDir) return { rows: [], readable: false };
  /** @type {Record<string, any>[]} */
  const rows = [];
  let text;
  try {
    text = fs.readFileSync(path.join(sessionDir, 'dispatches.jsonl'), 'utf8');
  } catch (err) {
    // No dispatches is the common case, not an error.
    return { rows: [], readable: /** @type {any} */ (err)?.code === 'ENOENT' };
  }
  let readable = true;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A half-written line from a killed hook must not hide the rest.
      readable = false;
    }
  }
  return { rows, readable };
}

/**
 * The running dispatch count against the budget, ready to print.
 *
 * The count is the session's `decision: "allow"` and `decision: "rewrite"` lines in
 * `dispatches.jsonl` (a rewritten dispatch still runs; a denied one does not), the
 * log the model hook already writes — no hook changes, and nothing here can deny
 * a dispatch. `n` is null (shown `?`) when the log is unreadable, never 0.
 *
 * @param {{ sessionDir: string, cwd?: string }} opts `cwd` is the project root holding `.forge/config.json`
 * @returns {{ n: number | null, budget: number, line: string, warning: string | null }}
 */
export function dispatchBudgetState(opts) {
  const budget = resolveDispatchBudget(opts.cwd);
  const { rows, readable } = readDispatchesChecked(opts.sessionDir);
  const n = readable ? rows.filter((row) => row?.decision === 'allow' || row?.decision === 'rewrite').length : null;
  return {
    n,
    budget,
    line: `dispatches ${n ?? '?'}/${budget}`,
    warning:
      n !== null && n > budget
        ? `[forge] Dispatch budget exceeded: ${n} dispatches against budget ${budget}. Warning only — nothing is blocked.`
        : null,
  };
}

/**
 * Roll dispatch rows up into the counts the metrics document carries.
 *
 * `skipped` is the headline: a rewrite means the coordinator named a model the
 * policy had to correct, a denial means one it had to refuse, and both mean
 * `forge resolve-model` was skipped or its answer ignored. An unrecognised
 * decision still counts in `total` — a row nobody can classify is a reason to
 * look, not a reason to disappear.
 *
 * @param {Record<string, any>[] | null | undefined} rows
 * @returns {{ total: number, allowed: number, rewritten: number, denied: number, skipped: number }}
 */
export function foldDispatches(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const out = { ...EMPTY_DISPATCHES };
  for (const row of list) {
    out.total += 1;
    const bucket = BUCKET[row?.decision];
    if (bucket) out[bucket] += 1;
  }
  out.skipped = out.rewritten + out.denied;
  return out;
}
