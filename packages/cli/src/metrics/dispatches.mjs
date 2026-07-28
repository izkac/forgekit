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

/**
 * Record one dispatch decision against the active Forge session.
 *
 * @param {{ tool?: string | null, agentType?: string | null,
 *   modelRequested?: string | null, modelResolved?: string | null,
 *   decision?: string, reason?: string | null, toolUseId?: string | null }} row
 * @param {{ forgeDir?: string, cwd?: string, now?: () => Date }} [opts]
 * @returns {boolean} whether a line was written — false is a normal outcome
 */
export function appendDispatch(row, opts = {}) {
  try {
    if (!row || typeof row !== 'object') return false;
    const dir = activeSessionDir(resolveForgeDir(opts ?? {}));
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
  if (typeof sessionDir !== 'string' || !sessionDir) return [];
  /** @type {Record<string, any>[]} */
  const rows = [];
  let text;
  try {
    text = fs.readFileSync(path.join(sessionDir, 'dispatches.jsonl'), 'utf8');
  } catch {
    return []; // no dispatches is the common case, not an error
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A half-written line from a killed hook must not hide the rest.
    }
  }
  return rows;
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
