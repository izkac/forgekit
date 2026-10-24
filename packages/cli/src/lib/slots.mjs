/**
 * Worktree slots: a small stable integer per checkout, so parallel worktrees can
 * derive non-colliding ports, database names and the like from `forge slot`.
 *
 * The repository's main worktree (and any non-git directory) is slot 0. A linked
 * worktree gets the lowest free integer >= 1, recorded in
 * `<git-common-dir>/forge/slots.json` (`{ "<worktree path>": n }`) under the
 * internal lease `_slots`. Entries whose worktree git no longer lists are pruned
 * on every allocation, so a removed worktree frees its number.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireLease } from './lease.mjs';

/**
 * Comparable form of a path: git prints forward slashes on Windows and
 * `path.resolve` gives backslashes; Windows paths also differ only by case.
 * @param {string} p
 * @returns {string}
 */
function normalizePath(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string | null} trimmed stdout, or null when git fails
 */
function gitOut(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false });
  return res.status === 0 && typeof res.stdout === 'string' ? res.stdout.trim() : null;
}

/**
 * Worktree paths from `git worktree list --porcelain`, main worktree first.
 * @param {string} cwd
 * @returns {string[] | null}
 */
function listWorktrees(cwd) {
  const res = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8', shell: false });
  if (res.status !== 0 || typeof res.stdout !== 'string') return null;
  return res.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

/**
 * @param {string} file
 * @returns {{ slots: Record<string, number>, corrupt: boolean }}
 */
function readSlotsFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // No file yet is the normal first allocation; any other read failure is a rebuild.
    return { slots: {}, corrupt: /** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT' };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { slots: {}, corrupt: true };
    /** @type {Record<string, number>} */
    const slots = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Number.isInteger(value) && /** @type {number} */ (value) >= 1) slots[normalizePath(key)] = /** @type {number} */ (value);
    }
    return { slots, corrupt: false };
  } catch {
    return { slots: {}, corrupt: true };
  }
}

/**
 * This checkout's slot: 0 for the main worktree and for non-git directories.
 *
 * @param {string} cwd
 * @param {{ notify?: (message: string) => void }} [opts]
 * @returns {number}
 */
export function slotFor(cwd, { notify = (m) => process.stderr.write(`${m}\n`) } = {}) {
  const top = gitOut(cwd, ['rev-parse', '--show-toplevel']);
  const listed = top ? listWorktrees(cwd) : null;
  if (!top || !listed || listed.length === 0) return 0;

  const self = normalizePath(top);
  // The first entry is the main worktree. In a bare-repo setup it is the bare repo itself, so
  // linked worktrees get 1, 2, … and nothing gets 0 (by design, D6).
  if (normalizePath(listed[0]) === self) return 0;

  const common = gitOut(cwd, ['rev-parse', '--git-common-dir']);
  if (!common) return 0;
  const file = path.join(path.resolve(cwd, common), 'forge', 'slots.json');
  const live = new Set(listed.map(normalizePath));

  // Fast path: a worktree that already has a slot never takes the lease. Only first
  // allocation (and the pruning that comes with it) is serialised.
  const known = readSlotsFile(file);
  if (!known.corrupt && live.has(self) && known.slots[self] !== undefined) return known.slots[self];

  // The critical section is microseconds, so poll fast: the 5 s default stalls parallel starts.
  const release = acquireLease({ cwd, name: '_slots', internal: true, pollMs: 50, notify });
  try {
    const { slots: stored, corrupt } = readSlotsFile(file);
    if (corrupt) notify(`[forge] Warning: could not read ${file} — rebuilt`);

    /** @type {Record<string, number>} */
    const slots = {};
    const taken = new Set();
    for (const [key, n] of Object.entries(stored)) {
      if (!live.has(key) || taken.has(n)) continue;
      slots[key] = n;
      taken.add(n);
    }
    if (slots[self] === undefined) {
      let n = 1;
      while (taken.has(n)) n += 1;
      slots[self] = n;
    }

    const next = JSON.stringify(slots, null, 2);
    let current = null;
    try {
      current = fs.readFileSync(file, 'utf8');
    } catch {
      // absent or unreadable — rewritten below
    }
    if (current !== next) {
      const tmp = `${file}.tmp-${process.pid}`;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(tmp, next, 'utf8');
        fs.renameSync(tmp, file);
      } catch (err) {
        notify(`[forge] Warning: could not record the slot in ${file} (${/** @type {Error} */ (err).message}) — it may change on the next run`);
        try {
          fs.unlinkSync(tmp);
        } catch {
          // never written
        }
      }
    }
    return slots[self];
  } finally {
    release();
  }
}

/** @param {unknown} v */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The `slots.env` templates from `<cwd>/.forge/config.json`: variable name →
 * template string. `env` is null when nothing is configured; entries whose value
 * is not a string are skipped with a warning.
 *
 * @param {string} cwd
 * @returns {{ env: Record<string, string> | null, warnings: string[] }}
 */
export function readSlotEnvConfig(cwd) {
  /** @type {string[]} */
  const warnings = [];
  const file = path.join(cwd, '.forge', 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { env: null, warnings };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { env: null, warnings: [`[forge] Warning: could not parse ${file} (${/** @type {Error} */ (err).message}) — no slot env configured`] };
  }
  const env = isPlainObject(parsed) && isPlainObject(parsed.slots) ? parsed.slots.env : undefined;
  if (env === undefined) return { env: null, warnings };
  if (!isPlainObject(env)) {
    return { env: null, warnings: [`[forge] Warning: "slots.env" in ${file} must be an object from variable name to template — ignored`] };
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const [name, template] of Object.entries(env)) {
    if (typeof template !== 'string') {
      warnings.push(`[forge] Warning: slots.env.${name} must be a string template, got ${JSON.stringify(template)} — skipped`);
      continue;
    }
    out[name] = template;
  }
  return { env: out, warnings };
}

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BRACE_EXPR = /\{([^{}]*)\}/g;

/**
 * Expand the templates for one slot. `FORGE_SLOT` is always first. A template
 * understands `{slot}` and `{N+slot}` (N a non-negative integer); any other
 * `{…}` is left as written, with a warning.
 *
 * @param {Record<string, string>} templates
 * @param {number} slot
 * @returns {{ vars: [string, string][], warnings: string[] }}
 */
export function renderSlotEnv(templates, slot) {
  /** @type {[string, string][]} */
  const vars = [['FORGE_SLOT', String(slot)]];
  /** @type {string[]} */
  const warnings = [];
  for (const [name, template] of Object.entries(templates ?? {})) {
    if (name === 'FORGE_SLOT') {
      warnings.push('[forge] Warning: slots.env.FORGE_SLOT is set by forge itself — skipped');
      continue;
    }
    if (!VAR_NAME.test(name)) {
      warnings.push(`[forge] Warning: slots.env variable name ${JSON.stringify(name)} is invalid (must match ${VAR_NAME.source}) — skipped`);
      continue;
    }
    const value = template.replace(BRACE_EXPR, (whole, expr) => {
      if (expr === 'slot') return String(slot);
      const plus = /^(\d+)\+slot$/.exec(expr);
      if (plus) return String(Number(plus[1]) + slot);
      warnings.push(`[forge] Warning: slots.env.${name}: unsupported expression ${whole} (only {slot} and {N+slot}) — left as written`);
      return whole;
    });
    vars.push([name, value]);
  }
  return { vars, warnings };
}

export const SLOT_SHELLS = Object.freeze(['dotenv', 'bash', 'powershell']);

/**
 * @param {[string, string][]} vars
 * @param {string} shell one of SLOT_SHELLS
 * @returns {string} one assignment per line, newline-terminated
 */
export function formatSlotEnv(vars, shell) {
  /** @type {(name: string, value: string) => string} */
  let line;
  if (shell === 'dotenv') {
    // Backslash-escape dialect. Node --env-file and npm dotenv do not unescape \\ or \", but
    // typical values (ports, URLs, names) never need quoting.
    line = (name, value) => `${name}=${/[\s#"']/.test(value) ? `"${value.replace(/[\\"]/g, '\\$&')}"` : value}`;
  } else if (shell === 'bash') {
    line = (name, value) => `export ${name}='${value.replace(/'/g, "'\\''")}'`;
  } else if (shell === 'powershell') {
    // PowerShell also treats U+2018 to U+201B as single quotes; double every one of them.
    line = (name, value) => `$env:${name} = '${value.replace(/['‘’‚‛]/g, '$&$&')}'`;
  } else {
    throw new Error(`unknown shell ${JSON.stringify(shell)} (use ${SLOT_SHELLS.join(', ')})`);
  }
  return vars.map(([name, value]) => `${line(name, value)}\n`).join('');
}

/**
 * Write `<cwd>/.forge/slot.env` (dotenv syntax) when `slots.env` is configured,
 * and only when its content differs from what is there. Not configured → does
 * nothing and never creates the file. Never throws: callers are hooks and
 * bootstrap, so a failure warns and returns null.
 *
 * @param {string} cwd
 * @param {{ slot?: number, warn?: (message: string) => void }} [opts]
 *   `slot` skips the lookup when the caller already has it; `warn` defaults to stderr.
 * @returns {{ written: boolean, path: string, slot: number } | null}
 */
export function writeSlotEnvFile(cwd, { slot, warn = (m) => process.stderr.write(`${m}\n`) } = {}) {
  const file = path.join(cwd, '.forge', 'slot.env');
  try {
    const config = readSlotEnvConfig(cwd);
    for (const w of config.warnings) warn(w);
    if (!config.env) return null;

    const n = slot ?? slotFor(cwd, { notify: warn });
    const rendered = renderSlotEnv(config.env, n);
    for (const w of rendered.warnings) warn(w);
    const content = `# written by forge — slot ${n}; do not edit\n${formatSlotEnv(rendered.vars, 'dotenv')}`;

    let current = null;
    try {
      current = fs.readFileSync(file, 'utf8');
    } catch {
      // absent — written below
    }
    if (current === content) return { written: false, path: file, slot: n };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Temp file + rename, so a concurrent reader never sees a truncated file.
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, content, 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // never written
      }
      throw err;
    }
    return { written: true, path: file, slot: n };
  } catch (err) {
    warn(`[forge] Warning: could not write ${file} (${/** @type {Error} */ (err).message})`);
    return null;
  }
}
