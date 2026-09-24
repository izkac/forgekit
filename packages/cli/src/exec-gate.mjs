/**
 * Opt-in / confirmation gate for caller-chosen argv execution.
 *
 * `forge evidence -- <cmd>` and `forge tdd run -- <cmd>` spawn the tokens
 * after `--` as the invoking user (`shell: false`, no allowlist). That trust
 * boundary is intentional — evidence has to be a product of execution — but
 * a confused or compromised agent must not be able to do it silently.
 *
 * Default: refuse. Opt in with any one of:
 *   - `FORGEKIT_ALLOW_EXEC=1` (CI / non-interactive sessions the operator
 *     already configured)
 *   - `.forge/preferences.local.json` → `exec.allowCallerCommands: true`
 *     (`forge prefs -- --set exec.allowCallerCommands=true`)
 *   - an interactive TTY confirm (stdin + stderr are terminals)
 *
 * Hypothesis: env + checkout pref + TTY confirm is the shape that matches
 * existing Forge prefs/env (FORGEKIT_* overrides, preferences.local.json,
 * `@inquirer` confirms on init). A CLI `--allow-exec` flag is deliberately
 * omitted — an agent that can invoke `forge` can add a flag as silently as
 * it can add argv after `--`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadLocalPreferences } from './preferences.mjs';

export const ALLOW_EXEC_ENV = 'FORGEKIT_ALLOW_EXEC';

/** Spawn option both exec sites must pass — never a shell string. */
export const CALLER_EXEC_SPAWN = Object.freeze({ shell: false });

const TRUTHY = /^(1|true|yes|on)$/i;

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function envAllowsCallerExec(env = process.env) {
  const raw = env?.[ALLOW_EXEC_ENV];
  return typeof raw === 'string' && TRUTHY.test(raw.trim());
}

/**
 * @param {unknown} local
 */
export function prefsAllowCallerExec(local) {
  return local != null && typeof local === 'object' && local.exec?.allowCallerCommands === true;
}

/**
 * @param {{ cwd?: string, forgeDir?: string }} [paths]
 */
export function localPrefsAllowCallerExec(paths = {}) {
  try {
    const { local } = loadLocalPreferences(paths);
    return prefsAllowCallerExec(local);
  } catch {
    return false;
  }
}

/**
 * @param {string[]} cmdArgv
 */
export function formatCallerArgv(cmdArgv) {
  return (Array.isArray(cmdArgv) ? cmdArgv : []).map((t) => {
    const s = String(t);
    return /[\s"']/.test(s) ? JSON.stringify(s) : s;
  }).join(' ');
}

/**
 * Refusal text shared by both exec sites so operators see one recipe.
 *
 * @param {string} command
 */
export function callerExecDeniedMessage(command) {
  return (
    `${command}: refusing to execute caller-chosen argv without operator opt-in.\n` +
    'This is the trust boundary: tokens after `--` spawn as you (`shell: false`, no allowlist).\n' +
    'Opt in with one of:\n' +
    `  - ${ALLOW_EXEC_ENV}=1          # CI / already-trusted non-interactive session\n` +
    '  - forge prefs -- --set exec.allowCallerCommands=true\n' +
    '  - confirm at the TTY prompt when stdin and stderr are a terminal\n'
  );
}

/**
 * Sync TTY confirm. Returns false when either stream is not a TTY, on read
 * errors, or on any answer other than y/yes. Injectable `readLine` keeps
 * tests off a real fd.
 *
 * @param {string[]} cmdArgv
 * @param {{
 *   stdin?: NodeJS.ReadStream,
 *   stderr?: NodeJS.WriteStream,
 *   readLine?: () => string,
 * }} [io]
 */
export function promptCallerExecConfirm(cmdArgv, io = {}) {
  const stdin = io.stdin ?? process.stdin;
  const stderr = io.stderr ?? process.stderr;
  if (!stdin.isTTY || !stderr.isTTY) return false;
  stderr.write(
    `forge: about to execute as you (shell: false, no allowlist):\n  ${formatCallerArgv(cmdArgv)}\nProceed? [y/N] `,
  );
  try {
    const line =
      typeof io.readLine === 'function'
        ? io.readLine()
        : readStdinLineSync(stdin);
    const answer = String(line ?? '').trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } catch {
    return false;
  }
}

/**
 * @param {NodeJS.ReadStream} stdin
 */
function readStdinLineSync(stdin) {
  const buf = Buffer.alloc(256);
  const n = fs.readSync(stdin.fd, buf, 0, buf.length, null);
  return buf.toString('utf8', 0, n);
}

/**
 * @param {{
 *   command: string,
 *   cmdArgv: string[],
 *   cwd?: string,
 *   forgeDir?: string,
 *   env?: NodeJS.ProcessEnv,
 *   confirm?: ((cmdArgv: string[]) => boolean) | false,
 *   stdin?: NodeJS.ReadStream,
 *   stderr?: NodeJS.WriteStream,
 * }} opts
 * @returns {{ allowed: boolean, source: 'env' | 'pref' | 'confirm' | null, message?: string }}
 */
export function resolveCallerExecGate(opts) {
  const env = opts.env ?? process.env;
  if (envAllowsCallerExec(env)) return { allowed: true, source: 'env' };

  const forgeDir = opts.forgeDir ?? (opts.cwd ? path.join(opts.cwd, '.forge') : undefined);
  if (localPrefsAllowCallerExec({ cwd: opts.cwd, forgeDir })) {
    return { allowed: true, source: 'pref' };
  }

  if (opts.confirm === false) {
    return { allowed: false, source: null, message: callerExecDeniedMessage(opts.command) };
  }
  const confirmed =
    typeof opts.confirm === 'function'
      ? opts.confirm(opts.cmdArgv)
      : promptCallerExecConfirm(opts.cmdArgv, opts);
  if (confirmed) return { allowed: true, source: 'confirm' };

  return { allowed: false, source: null, message: callerExecDeniedMessage(opts.command) };
}
