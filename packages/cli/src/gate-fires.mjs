/**
 * Gate fires (CONTEXT.md): one line per Forge gate refusal, in a single
 * machine-level log beside the fleet registry — `~/.forgekit/fleet/gate-fires.jsonl`.
 *
 * Machine-level rather than per-project because the fleet is mostly linked
 * worktrees that are deleted after merge, and their `.forge/` goes with them;
 * the 2027-04-24 review ("cut gates with zero fires across the fleet") would
 * read a log that had lost most of its lines.
 *
 * Kept light on purpose — fs only, no ledger.mjs — because the test-guard and
 * model-policy hooks import it and run on every tool call.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fleetDir, underTempDir } from './lib/fleet.mjs';

/**
 * Every gate that logs a fire. `forge fires` lists all of them, zeros included —
 * a gate that never fires is exactly what the report exists to find.
 */
export const GATE_IDS = [
  'integrity-seal',
  'brief',
  'brainstorm-notes',
  'leftover-sweep',
  'done:verify-evidence',
  'done:tasks',
  'done:combined-review',
  'done:archive',
  'done:integrity',
  'final-review-floor',
  'reopen-floor',
  'integrity-check',
  'test-guard',
  'model-policy',
  'evidence',
  'exec-gate',
  'tdd-expectation',
  'review-label',
  'task-gate',
  'checkpoint',
];

export function firesLogPath() {
  return path.join(path.dirname(fleetDir()), 'gate-fires.jsonl');
}

/**
 * Append one fire. Never throws and never changes the caller's exit: a gate
 * that refuses must refuse the same way whether or not its fire was logged.
 *
 * Scratch projects under the temp dir are skipped unless `FORGEKIT_FLEET_DIR`
 * points the log somewhere the caller owns — the same rule `registerSession`
 * uses, for the same reason (unit-suite fixtures must not reach `~/.forgekit`).
 *
 * ponytail: plain O_APPEND, no lock — each fire is one short write, which the OS
 * appends whole; switch to withLedgerLock if lines ever exceed a few hundred bytes.
 *
 * @param {string} gate one of GATE_IDS
 * @param {{ sessionId?: string | null, cwd?: string, detail?: string }} [opts]
 * @returns {boolean} whether a line was written
 */
export function recordGateFire(gate, { sessionId = null, cwd = process.cwd(), detail } = {}) {
  try {
    if (!process.env.FORGEKIT_FLEET_DIR && underTempDir(cwd)) return false;
    const line = { gate, sessionId, project: path.resolve(cwd), at: new Date().toISOString() };
    if (detail) line.detail = String(detail).slice(0, 200);
    const file = firesLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} [file]
 * @returns {Record<string, any>[]}
 */
export function readGateFires(file = firesLogPath()) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  /** @type {Record<string, any>[]} */
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A half-written line must not hide the rest.
    }
  }
  return out;
}

/**
 * Fire count, distinct sessions and last fire per gate — every known gate,
 * plus any id the log holds that this version does not know (a newer forge,
 * or a gate since renamed). Most-fired first.
 *
 * @param {Record<string, any>[]} fires
 * @param {{ since?: string | null }} [opts]
 */
export function summarizeGateFires(fires, { since = null } = {}) {
  const floor = since ? Date.parse(since) : -Infinity;
  /** @type {Map<string, { gate: string, fires: number, sessions: Set<string>, lastAt: string | null }>} */
  const rows = new Map(GATE_IDS.map((gate) => [gate, { gate, fires: 0, sessions: new Set(), lastAt: null }]));
  for (const fire of fires) {
    if (!fire || typeof fire.gate !== 'string') continue;
    if (!(Date.parse(fire.at) >= floor)) continue;
    if (!rows.has(fire.gate)) rows.set(fire.gate, { gate: fire.gate, fires: 0, sessions: new Set(), lastAt: null });
    const row = /** @type {NonNullable<ReturnType<typeof rows.get>>} */ (rows.get(fire.gate));
    row.fires += 1;
    if (fire.sessionId) row.sessions.add(fire.sessionId);
    if (!row.lastAt || fire.at > row.lastAt) row.lastAt = fire.at;
  }
  return [...rows.values()]
    .map((r) => ({ gate: r.gate, fires: r.fires, sessions: r.sessions.size, lastAt: r.lastAt }))
    .sort((a, b) => b.fires - a.fires || a.gate.localeCompare(b.gate));
}
