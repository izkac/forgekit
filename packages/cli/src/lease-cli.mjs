#!/usr/bin/env node
/**
 * `forge lease` — run a command while holding a named, exclusive lease, and
 * list who holds what.
 *
 *   forge lease <name> [--wait-ms N] -- <cmd…>   take the lease, run the command, release, exit with its code
 *   forge lease list [--json]                    every lease file with its holder and whether the holder is alive
 *   forge lease check --command "<cmd>" [--json] would a configured lease guard <cmd>? (read by the guard hook)
 *
 * `<name>` matches ^[a-z0-9][a-z0-9-]*$. "tier3" and "_"-prefixed names are
 * reserved for `forge evidence`, "list" and "check" for the subcommands above.
 * Any other name is accepted as an ad-hoc lease.
 * The wait is `--wait-ms`, else the lease's configured `waitMs`, else 540000.
 *
 * `check` always exits 0 for deny and none alike (the hook reads the JSON).
 * Exit codes: the command's own exit code; 75 lease busy past the wait (the
 * command never ran); 2 usage error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { acquireLease, isValidLeaseName, LeaseBusyError, leaseChildEnv, listLeases } from './lib/lease.mjs';
import { matchLease, readLeaseConfig, SUBCOMMAND_NAMES } from './lib/lease-config.mjs';
import { recordGateFire } from './gate-fires.mjs';

const DEFAULT_WAIT_MS = 540000;
const EXIT_BUSY = 75;
const EXIT_USAGE = 2;
const NAME_RULE = '^[a-z0-9][a-z0-9-]*$';

const USAGE = `Usage:
  forge lease <name> [--wait-ms N] -- <cmd…>   run <cmd> while holding lease <name>
  forge lease list [--json]                    list leases and their holders
  forge lease check --command "<cmd>" [--json]  decide whether a configured lease guards <cmd>
`;

/**
 * Join argv into one command line for cmd.exe: an arg with whitespace or one of
 * "&|<>^() is double-quoted; an empty arg becomes "". Inside the quotes each
 * run of backslashes before a " (and before the closing quote) is doubled, as
 * the MSVCRT argv parser requires, and each " is doubled so cmd.exe sees the
 * quote state balanced.
 *
 * ponytail: still unhandled: cmd.exe expands %VAR% inside quoted args, and a
 * newline in an arg ends the command line. Wrap anything like that in a
 * project script and lease the script.
 * Upgrade: resolve the .cmd shim and spawn it with shell: false.
 *
 * @param {string[]} argv
 * @returns {string}
 */
export function buildWindowsCommand(argv) {
  const quote = (/** @type {string} */ arg) => `"${arg.replace(/(\\*)"/g, '$1$1""').replace(/\\+$/, '$&$&')}"`;
  return argv.map((arg) => (arg === '' || /[\s"&|<>^()]/.test(arg) ? quote(arg) : arg)).join(' ');
}

/** @param {string} message */
function usageError(message) {
  process.stderr.write(`forge lease: ${message}\n${USAGE}`);
  return EXIT_USAGE;
}

/**
 * Session id and slug from the active Forge session, or nulls — never an error.
 *
 * @param {string} cwd
 * @returns {{ sessionId: string | null, slug: string | null }}
 */
function activeSession(cwd) {
  try {
    const forgeDir = path.join(cwd, '.forge');
    const sessionId = JSON.parse(fs.readFileSync(path.join(forgeDir, 'active.json'), 'utf8'))?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) return { sessionId: null, slug: null };
    let slug = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(forgeDir, 'sessions', sessionId, 'session.json'), 'utf8'))?.slug;
      slug = typeof parsed === 'string' && parsed ? parsed : null;
    } catch {
      // no readable session.json — the holder just won't carry a slug
    }
    return { sessionId, slug };
  } catch {
    return { sessionId: null, slug: null };
  }
}

/**
 * Run the command through the platform's normal path: argv with no shell on
 * POSIX; on Windows a quoted command line through cmd.exe, because
 * `spawnSync('npm', …, { shell: false })` cannot start `npm.cmd`.
 *
 * Not routed through the exec gate: the command is typed into the host's own
 * shell tool, so the host's permission system has already seen it.
 *
 * @param {string[]} cmdArgv
 * @param {NodeJS.ProcessEnv} env  what the command inherits (carries FORGE_LEASES_HELD)
 * @returns {number}
 */
function runCommand(cmdArgv, env) {
  // bin/forge.mjs runs this script from the project root and records where the
  // user actually was; the wrapped command belongs there (e.g. packages/api).
  const invokedFrom = process.env.FORGE_INVOKED_FROM;
  const cwd = invokedFrom && fs.existsSync(invokedFrom) ? invokedFrom : process.cwd();
  const res =
    process.platform === 'win32'
      ? spawnSync(buildWindowsCommand(cmdArgv), { stdio: 'inherit', shell: true, env, cwd })
      : spawnSync(cmdArgv[0], cmdArgv.slice(1), { stdio: 'inherit', shell: false, env, cwd });
  if (res.error) {
    process.stderr.write(`forge lease: could not run ${cmdArgv[0]}: ${res.error.message}\n`);
    return 1;
  }
  return res.status ?? 1; // killed by a signal → no status
}

/**
 * @param {string[]} args  everything after `forge lease`, starting with the lease name
 * @param {string} cwd
 * @returns {number} exit code
 */
function runLease(args, cwd) {
  const name = args[0];
  if (SUBCOMMAND_NAMES.includes(name)) {
    process.stderr.write(`forge lease: ${JSON.stringify(name)} is a reserved name (a forge lease subcommand): pick another lease name matching ${NAME_RULE}\n`);
    return EXIT_USAGE;
  }
  if (!isValidLeaseName(name) || name === 'tier3') {
    process.stderr.write(
      `forge lease: invalid lease name ${JSON.stringify(name)}: names must match ${NAME_RULE} ("tier3" and "_"-prefixed names are reserved)\n`,
    );
    return EXIT_USAGE;
  }

  let waitOverride = null;
  let sep = -1;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === '--') {
      sep = i;
      break;
    }
    if (args[i] === '--wait-ms') {
      const raw = args[(i += 1)];
      if (raw === undefined || !/^\d+$/.test(raw)) return usageError(`--wait-ms needs a non-negative integer, got: ${raw ?? '(nothing)'}`);
      waitOverride = Number(raw);
    } else {
      return usageError(`unexpected argument before "--": ${args[i]}`);
    }
  }
  if (sep < 0) return usageError('missing "--" before the command');
  const cmdArgv = args.slice(sep + 1);
  if (cmdArgv.length === 0) return usageError('no command after "--"');

  let waitMs = DEFAULT_WAIT_MS;
  if (waitOverride !== null) {
    waitMs = waitOverride;
  } else {
    const config = readLeaseConfig(cwd);
    for (const warning of config.warnings) process.stderr.write(`${warning}\n`);
    waitMs = config.leases.find((l) => l.name === name)?.waitMs ?? DEFAULT_WAIT_MS;
  }

  const { sessionId, slug } = activeSession(cwd);
  let release;
  try {
    release = acquireLease({ cwd, name, sessionId, slug, waitMs });
  } catch (err) {
    if (!(err instanceof LeaseBusyError)) throw err;
    const h = err.holder;
    process.stderr.write(
      `[forge] lease ${name} busy — held by ${h?.slug || h?.sessionId || h?.pid || 'unknown'} (pid ${h?.pid ?? 'unknown'}, since ${h?.startedAt ?? 'unknown'}); retry later or run in background\n`,
    );
    recordGateFire('lease-busy', { sessionId, cwd, detail: name });
    return EXIT_BUSY;
  }
  try {
    return runCommand(cmdArgv, leaseChildEnv({ cwd, name }));
  } finally {
    release();
  }
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {number}
 */
function runList(args, cwd) {
  const extra = args.filter((a) => a !== '--json');
  if (extra.length > 0) return usageError(`unexpected argument: ${extra[0]}`);
  const leases = listLeases(cwd);
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(leases, null, 2)}\n`);
    return 0;
  }
  if (leases.length === 0) {
    process.stdout.write('no leases\n');
    return 0;
  }
  for (const l of leases) {
    const h = /** @type {{ pid?: number, sessionId?: string | null, slug?: string | null, startedAt?: string } | null} */ (l.holder);
    process.stdout.write(
      `${l.name}  held by ${h?.slug || h?.sessionId || 'unknown'} (pid ${h?.pid ?? 'unknown'}, ${l.alive ? 'alive' : 'dead'}, since ${h?.startedAt ?? 'unknown'})\n`,
    );
  }
  return 0;
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {number} exit code
 */
function runCheck(args, cwd) {
  let command = null;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--command') command = args[(i += 1)] ?? null;
    else if (args[i] === '--json') json = true;
    else return usageError(`unexpected argument: ${args[i]}`);
  }
  if (command === null) return usageError('check needs --command "<cmd>"');

  const config = readLeaseConfig(cwd);
  for (const warning of config.warnings) process.stderr.write(`${warning}\n`);
  const hit = matchLease(command, config);
  // ponytail: a plain substring test, so an operator inside quotes also counts as a chain; the
  // advice is then merely more cautious than needed. Upgrade: tokenise the shell line.
  const chained = /&&|\|\||;|\|/.test(command);
  const prefix = hit ? `This command matches lease "${hit.name}" (pattern ${hit.pattern}), so it must not run alongside other sessions. ` : '';
  const advice = hit
    ? chained
      ? `Blocked command: \`${command}\`. It is a shell chain, and \`forge lease ${hit.name} -- <whole chain>\` would lease only its first command. ` +
        `Wrap only the part that needs the lease as \`forge lease ${hit.name} -- <that part>\`, or move the chain into a project script and wrap that. ` +
        'Use a tool timeout of at least 10 minutes, or run it in the background.'
      : `Rerun it as: forge lease ${hit.name} -- ${command} — with a tool timeout of at least 10 minutes, or in the background.`
    : '';
  /** @type {{ action: 'none' } | { action: 'deny', lease: string, pattern: string, reason: string }} */
  const result = hit
    ? {
        action: 'deny',
        lease: hit.name,
        pattern: hit.pattern,
        reason: prefix + advice,
      }
    : { action: 'none' };
  // The guard hook's deny is decided here, so its Gate fire is logged here.
  // ponytail: a hand-run `forge lease check` that matches counts too — rare, and
  // overcounting can only keep a gate alive at the fire review, never cut one.
  if (hit) recordGateFire('lease-guard', { sessionId: activeSession(cwd).sessionId, cwd, detail: hit.name });
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${result.action === 'deny' ? result.reason : 'none'}\n`);
  return 0;
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {number} exit code
 */
export function runLeaseCli(args, cwd = process.cwd()) {
  if (args.length === 0) return usageError('a lease name or subcommand is required');
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  // `list -- <cmd>` / `check -- <cmd>` is an attempt to use the subcommand name as a lease: runLease refuses it.
  if (SUBCOMMAND_NAMES.includes(args[0]) && args.includes('--')) return runLease(args, cwd);
  if (args[0] === 'list') return runList(args.slice(1), cwd);
  if (args[0] === 'check') return runCheck(args.slice(1), cwd);
  return runLease(args, cwd);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) process.exit(runLeaseCli(process.argv.slice(2)));
