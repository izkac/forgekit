#!/usr/bin/env node
/**
 * Stop: the turn-end completion backstop. Blocks the turn from ending only
 * when the active Forge session claims completion (phase in
 * verify/review/finish, or implement with tasksComplete >= tasksTotal) while
 * `forge integrity-check` still fails.
 *
 * Design D-stop-gate: everything up to the claim-state test is plain
 * `node:fs` — no child process. A child (`forge integrity-check`) is spawned
 * ONLY once claim-state is confirmed; mid-implement turns with open tasks
 * must never pay that cost and must never spawn anything. The whole script
 * fails open — a broken hook must never trap the operator.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const FAST_EXIT_PHASES = new Set(['triage', 'brainstorm', 'plan', 'done', 'skipped']);

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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Command to run `forge`, as `{ cmd, baseArgs, shell }`. Defaults to `forge`
 * on PATH (quoted+shelled on win32, where `forge` is a `.cmd` shim — same
 * reasoning as the sibling PreToolUse/UserPromptSubmit hook templates).
 * `FORGE_STOP_HOOK_FORGE_CMD` overrides this for tests, e.g. `"node"
 * "<repo>/packages/cli/bin/forge.mjs"` — space-quoted tokens so an
 * interpreter or script path containing spaces still splits correctly.
 */
function resolveForgeInvocation() {
  const override = process.env.FORGE_STOP_HOOK_FORGE_CMD;
  if (typeof override === 'string' && override.trim()) {
    const tokens = override.match(/"[^"]*"|'[^']*'|\S+/g) || [];
    const parts = tokens.map((t) =>
      t.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'),
    );
    return { cmd: parts[0], baseArgs: parts.slice(1), shell: false };
  }
  return { cmd: 'forge', baseArgs: [], shell: process.platform === 'win32' };
}

async function main() {
  const raw = await readStdin();

  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    process.exit(0);
  }
  if (payload && typeof payload === 'object' && payload.stop_hook_active === true) {
    process.exit(0);
  }

  // --- Fast path: plain fs, no child process below this point unless the
  // claim-state test (further down) passes. ---
  const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  const activeFile = path.join(REPO_ROOT, '.forge', 'active.json');
  if (!fs.existsSync(activeFile)) process.exit(0);
  let active;
  try {
    active = readJson(activeFile);
  } catch {
    process.exit(0);
  }
  const sessionId = active && typeof active === 'object' ? active.sessionId : null;
  if (typeof sessionId !== 'string' || !sessionId) process.exit(0);

  const sessionFile = path.join(REPO_ROOT, '.forge', 'sessions', sessionId, 'session.json');
  if (!fs.existsSync(sessionFile)) process.exit(0);
  let session;
  try {
    session = readJson(sessionFile);
  } catch {
    process.exit(0);
  }
  if (!session || typeof session !== 'object') process.exit(0);

  if (FAST_EXIT_PHASES.has(session.phase)) process.exit(0);

  const configFile = path.join(REPO_ROOT, '.forge', 'config.json');
  if (fs.existsSync(configFile)) {
    let config;
    try {
      config = readJson(configFile);
    } catch {
      process.exit(0);
    }
    if (config?.hooks?.stopGate === 'off') process.exit(0);
  }

  const tasksTotal = Number(session.tasksTotal) || 0;
  const tasksComplete = Number(session.tasksComplete) || 0;
  const claimState =
    session.phase === 'verify' ||
    session.phase === 'review' ||
    session.phase === 'finish' ||
    (session.phase === 'implement' && tasksTotal > 0 && tasksComplete >= tasksTotal);

  if (!claimState) process.exit(0);

  // --- Claim-state only: spawn `forge integrity-check`. ---
  const { cmd, baseArgs, shell } = resolveForgeInvocation();
  const sessionArg = shell ? `"${sessionId.replaceAll('"', '""')}"` : sessionId;
  const r = spawnSync(cmd, [...baseArgs, 'integrity-check', '--session', sessionArg], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    shell,
  });

  if (r.status === 0) process.exit(0);

  const out = JSON.parse(r.stdout);
  const problems = Array.isArray(out.problems) ? out.problems : [];
  const reason =
    `Forge session ${sessionId} claims completion but forge integrity-check failed` +
    (problems.length ? `:\n- ${problems.join('\n- ')}` : '') +
    '\n\nFix the problems above, then re-check: forge integrity-check. ' +
    'Unresolved deferrals: forge defer list. Missing/stale E2E: forge e2e run.';

  process.stdout.write(`${JSON.stringify({ decision: 'block', reason })}\n`);
  process.exit(0);
}

main().catch(() => {
  process.exit(0);
});
