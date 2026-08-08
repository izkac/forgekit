#!/usr/bin/env node
/**
 * PreToolUse (Edit/Write/NotebookEdit): enforce the test-tamper guard.
 *
 * Thin shell around `forge guard check --file <path> --json` — the decision
 * (guarded classification, session phase, allowances) lives there; this only
 * carries the target path across and stays out of the way when it can't.
 *
 * Design D3: the hook fails open on any internal error (missing forge,
 * unreadable session, git failure, unparseable payload) — a broken guard
 * must never brick a session — but loudly, via a one-line stderr warning.
 * The integrity backstop is the separate, fail-closed layer.
 */

import { spawnSync } from 'node:child_process';

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const GUARDED_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

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

/** @param {string} message */
function warnAndAllow(message) {
  process.stderr.write(`[forge] Warning: ${message} — test-guard allowing.\n`);
  process.exit(0);
}

/** @param {string} message */
function deny(message) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: message,
      },
    })}\n`,
  );
  process.exit(0);
}

const raw = await readStdin();
if (!raw) process.exit(0);

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  warnAndAllow('could not parse hook payload as JSON');
}
if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
  warnAndAllow('hook payload was not a JSON object');
}

const toolName = payload.tool_name;
if (!GUARDED_TOOLS.has(toolName)) process.exit(0);

const toolInput = payload.tool_input;
const filePath =
  toolName === 'NotebookEdit'
    ? toolInput && toolInput.notebook_path
    : toolInput && toolInput.file_path;

if (typeof filePath !== 'string' || filePath.length === 0) {
  warnAndAllow(`${toolName} tool_input carried no usable file path`);
}

// `forge` is a `.cmd` shim on win32, so it can only be found via the shell —
// but shell:true joins argv into an unquoted command string, so the path
// must be quoted by hand there. Everywhere else, shell:false passes argv
// straight to execve, so `filePath` reaches `forge` untouched regardless of
// spaces or shell metacharacters.
const useShell = process.platform === 'win32';
const fileArg = useShell ? `"${filePath.replaceAll('"', '""')}"` : filePath;
const r = spawnSync('forge', ['guard', 'check', '--file', fileArg, '--json'], {
  encoding: 'utf8',
  cwd: REPO_ROOT,
  shell: useShell,
});

if (r.status === 0) process.exit(0);

if (r.status === 2) {
  let message = `Guarded: ${filePath}. Escape: forge test-allow ${filePath} --reason "<why>"`;
  try {
    const out = JSON.parse(r.stdout);
    if (out && typeof out.message === 'string') message = out.message;
  } catch {
    // Keep the default message above.
  }
  deny(message);
}

warnAndAllow(`forge guard check exited ${r.status === null ? 'without a status' : r.status}`);
