#!/usr/bin/env node
/**
 * PreToolUse (Bash|PowerShell): deny a command that matches a configured
 * resource lease and tell the agent to rerun it as `forge lease <name> -- …`.
 *
 * Thin shell around `forge lease check --command <cmd> --json` — the matching
 * lives there; this carries the command across and stays out of the way.
 *
 * Deny-only (design D1): this hook prints a deny decision or nothing. It never
 * prints allow, ask or updatedInput, so every other decision stays with the
 * host's own permission system. It fails open on any internal error, loudly,
 * via a one-line stderr warning.
 *
 * Fast path (design D5): without a lease that has `match` entries in
 * .forge/config.json it exits silently without spawning forge.
 *
 * Hosts: Claude Code by default; `--format cursor` serves a Cursor
 * `preToolUse` hook (matcher `Shell`) and prints Cursor's deny shape instead.
 * Cursor input is `tool_input.command` per its hooks docs; a top-level
 * `command` (the beforeShellExecution shape) is accepted as well. Every
 * non-deny path prints nothing, so the host decides: exit 0 for Claude, exit 1
 * for Cursor (see passThrough).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveForgeInvocation } from './resolve-forge.mjs';

const formatAt = process.argv.indexOf('--format');
const CURSOR = process.argv.includes('--format=cursor') || (formatAt >= 0 && process.argv[formatAt + 1] === 'cursor');
const PROJECT_DIR = (CURSOR && process.env.CURSOR_PROJECT_DIR) || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const GUARDED_TOOLS = new Set(CURSOR ? ['Shell'] : ['Bash', 'PowerShell']);

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    setTimeout(() => resolve(data), 1500);
  });
}

/**
 * End the run without a decision, leaving the call to the host.
 *
 * Claude Code: exit 0 with no output. Cursor: exit 1 with no output — its docs
 * say exit 0 means "use the JSON output" and permission hooks "block on invalid
 * JSON or an invalid response", exit 2 blocks, and "Other exit codes - Hook
 * failed, action proceeds (fail-open by default)". Printing {"permission":
 * "allow"} would approve the call, which this hook never does.
 * ponytail: if Cursor ever documents a no-decision passthrough on exit 0,
 * switch to it.
 */
function passThrough() {
  process.exit(CURSOR ? 1 : 0);
}

/** @param {string} message */
function warnAndAllow(message) {
  process.stderr.write(`[forge] Warning: ${message} — lease-guard allowing.\n`);
  passThrough();
}

/** @param {string} message */
function deny(message) {
  const decision = CURSOR
    ? {
        permission: 'deny',
        user_message: 'Blocked: this command needs a resource lease. The agent was told how to rerun it.',
        agent_message: message,
      }
    : {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: message,
        },
      };
  process.stdout.write(`${JSON.stringify(decision)}\n`);
  process.exit(0);
}

/** Whether .forge/config.json has at least one lease with a non-empty `match` array. */
function hasLeaseMatchConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, '.forge', 'config.json'), 'utf8'));
    const leases = config && typeof config === 'object' ? config.leases : null;
    if (!leases || typeof leases !== 'object' || Array.isArray(leases)) return false;
    return Object.values(leases).some(
      (lease) => lease && typeof lease === 'object' && Array.isArray(lease.match) && lease.match.length > 0,
    );
  } catch {
    return false;
  }
}

const raw = await readStdin();
if (!raw) passThrough();
if (!hasLeaseMatchConfig()) passThrough();

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  warnAndAllow('could not parse hook payload as JSON');
}
if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
  warnAndAllow('hook payload was not a JSON object');
}

// Cursor's top-level `command` shape carries no tool_name; any named tool must be a guarded one.
if ((payload.tool_name !== undefined || !CURSOR) && !GUARDED_TOOLS.has(payload.tool_name)) passThrough();

const command = (payload.tool_input && payload.tool_input.command) ?? (CURSOR ? payload.command : undefined);
if (typeof command !== 'string') {
  warnAndAllow(`${payload.tool_name ?? 'hook payload'} carried no command string`);
}

// `node` + `forge.mjs` (shell: false) on every platform, including Windows
// where `forge` is a `.cmd` shim. argv is never joined into a cmd.exe string,
// so `command` reaches `forge` untouched whatever metacharacters it holds.
//
// spawnSync can throw (a NUL byte in an argument is ERR_INVALID_ARG_VALUE), so a
// throw is routed to the same warn-and-allow as a spawn error. The timeout
// bounds a hung forge; FORGE_LEASE_GUARD_TIMEOUT_MS overrides it for tests.
const timeoutEnv = Number(process.env.FORGE_LEASE_GUARD_TIMEOUT_MS);
const TIMEOUT_MS = Number.isInteger(timeoutEnv) && timeoutEnv > 0 ? timeoutEnv : 10000;
let r;
try {
  const { cmd, baseArgs } = resolveForgeInvocation();
  r = spawnSync(cmd, [...baseArgs, 'lease', 'check', '--command', command, '--json'], {
    encoding: 'utf8',
    cwd: PROJECT_DIR,
    shell: false,
    timeout: TIMEOUT_MS,
  });
} catch (err) {
  warnAndAllow(`could not run forge (${err instanceof Error ? err.message : String(err)})`);
}

if (r.error) warnAndAllow(`could not run forge (${r.error.message})`);
if (r.status !== 0) {
  warnAndAllow(`forge lease check exited ${r.status === null ? 'without a status' : r.status}`);
}

let result;
try {
  result = JSON.parse(r.stdout);
} catch {
  warnAndAllow('forge lease check printed output that is not JSON');
}

if (result && result.action === 'deny' && typeof result.reason === 'string') deny(result.reason);
if (result && result.action === 'none') passThrough();
warnAndAllow('forge lease check returned an unrecognised result');
