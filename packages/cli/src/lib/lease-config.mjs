/**
 * Opt-in lease configuration from `.forge/config.json`:
 *
 *   { "leases": { "<name>": { "match": ["<regex source>", …], "waitMs": 540000 } } }
 *
 * `match` entries are JavaScript regular-expression sources tested against the
 * whole command string; `waitMs` bounds how long a wrapped command waits for the
 * lease. Without a `leases` key nothing is configured and only the built-in
 * `tier3` lease exists. Bad entries are skipped with a warning, never fatal.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isValidLeaseName } from './lease.mjs';

const DEFAULT_WAIT_MS = 540000;

/** `forge lease` subcommands: a lease with one of these names could not be run as `forge lease <name> -- <cmd>`. */
export const SUBCOMMAND_NAMES = Object.freeze(['list', 'check']);

/**
 * @typedef {{ name: string, match: RegExp[], patterns: string[], waitMs: number }} LeaseSpec
 * @typedef {{ leases: LeaseSpec[], warnings: string[] }} LeaseConfig
 */

/** @param {unknown} v */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * @param {string} cwd
 * @returns {LeaseConfig}
 */
export function readLeaseConfig(cwd) {
  /** @type {string[]} */
  const warnings = [];
  const file = path.join(cwd, '.forge', 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { leases: [], warnings };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { leases: [], warnings: [`[forge] Warning: could not parse ${file} (${/** @type {Error} */ (err).message}) — no leases configured`] };
  }
  const section = isPlainObject(parsed) ? parsed.leases : undefined;
  if (section === undefined) return { leases: [], warnings };
  if (!isPlainObject(section)) {
    return { leases: [], warnings: [`[forge] Warning: "leases" in ${file} must be an object from lease name to settings — ignored`] };
  }

  /** @type {LeaseSpec[]} */
  const leases = [];
  for (const name of Object.keys(section).sort()) {
    if (name === 'tier3') {
      warnings.push('[forge] Warning: lease "tier3" is built in (forge evidence) and cannot be configured — ignored');
      continue;
    }
    if (SUBCOMMAND_NAMES.includes(name)) {
      warnings.push(`[forge] Warning: lease name "${name}" is reserved (a forge lease subcommand) — ignored`);
      continue;
    }
    if (!isValidLeaseName(name)) {
      warnings.push(`[forge] Warning: lease name ${JSON.stringify(name)} is invalid (use lowercase letters, digits and "-", starting with a letter or digit) — ignored`);
      continue;
    }
    const entry = section[name];
    if (!isPlainObject(entry)) {
      warnings.push(`[forge] Warning: lease "${name}" must be an object — ignored`);
      continue;
    }

    /** @type {RegExp[]} */
    const match = [];
    /** @type {string[]} */
    const patterns = [];
    if (entry.match !== undefined) {
      if (!Array.isArray(entry.match)) {
        warnings.push(`[forge] Warning: lease "${name}": "match" must be an array of regular-expression strings — ignored`);
      } else {
        for (const pattern of entry.match) {
          if (typeof pattern !== 'string') {
            warnings.push(`[forge] Warning: lease "${name}": match entry ${JSON.stringify(pattern)} is not a string — skipped`);
            continue;
          }
          try {
            match.push(new RegExp(pattern));
            patterns.push(pattern);
          } catch (err) {
            warnings.push(`[forge] Warning: lease "${name}": match pattern ${JSON.stringify(pattern)} does not compile (${/** @type {Error} */ (err).message}) — skipped`);
          }
        }
      }
    }

    let waitMs = DEFAULT_WAIT_MS;
    if (entry.waitMs !== undefined) {
      if (typeof entry.waitMs === 'number' && Number.isFinite(entry.waitMs) && entry.waitMs > 0) {
        waitMs = entry.waitMs;
      } else {
        warnings.push(`[forge] Warning: lease "${name}": waitMs ${JSON.stringify(entry.waitMs)} must be a positive number — using ${DEFAULT_WAIT_MS}`);
      }
    }
    leases.push({ name, match, patterns, waitMs });
  }
  return { leases, warnings };
}

/**
 * The first configured lease whose pattern hits `command`, or null. A command
 * that already goes through `forge lease` or `forge evidence` is never matched.
 *
 * @param {string} command
 * @param {LeaseConfig} config
 * @returns {{ name: string, pattern: string } | null}
 */
export function matchLease(command, config) {
  if (command.includes('forge lease') || command.includes('forge evidence')) return null;
  for (const lease of config.leases) {
    for (let i = 0; i < lease.match.length; i += 1) {
      if (lease.match[i].test(command)) return { name: lease.name, pattern: lease.patterns[i] };
    }
  }
  return null;
}

/**
 * Every configured lease (name order) with at least one pattern hitting
 * `command`. Unlike `matchLease` there is no already-wrapped exemption: the
 * caller (`forge evidence`) passes the command it is about to execute, and that
 * inner command is what needs the lease.
 *
 * @param {string} command
 * @param {LeaseConfig} config
 * @returns {{ name: string, pattern: string, waitMs: number }[]} `pattern` is the first one that hit
 */
export function matchingLeases(command, config) {
  /** @type {{ name: string, pattern: string, waitMs: number }[]} */
  const hits = [];
  for (const lease of config.leases) {
    const i = lease.match.findIndex((re) => re.test(command));
    if (i >= 0) hits.push({ name: lease.name, pattern: lease.patterns[i], waitMs: lease.waitMs });
  }
  return hits;
}

/**
 * @param {LeaseConfig} config
 * @returns {boolean} whether any lease has a `match` pattern (lets the hook skip work otherwise)
 */
export function hasMatchPatterns(config) {
  return config.leases.some((l) => l.match.length > 0);
}
