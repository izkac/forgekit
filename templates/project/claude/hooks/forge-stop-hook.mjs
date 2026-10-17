#!/usr/bin/env node
/**
 * Stop: the turn-end completion backstop. Blocks the turn from ending only
 * when the active Forge session claims completion (phase in
 * verify/review/finish, or implement with tasksComplete >= tasksTotal) while
 * `forge integrity-check` still fails — or when integrity is green and the
 * session is ready to close (`review`/`finish`, or an approved final review)
 * but `forge phase done` never ran.
 *
 * The session is resolved like `forge reminder` (the active pointer if it
 * names an open session, else the only open one), except that a session whose
 * `host.sessionIds` holds the payload's `session_id` wins outright, and one
 * bound only to other host sessions is never ours — so a second agent in the
 * same checkout is not blocked by the first one's session.
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
import { resolveForgeInvocation } from './resolve-forge.mjs';

const FAST_EXIT_PHASES = new Set(['triage', 'brainstorm', 'plan', 'done', 'skipped']);
// Keep in sync with TERMINAL_PHASES in packages/cli/src/lib/fleet.mjs.
const TERMINAL_PHASES = new Set(['done', 'skipped']);

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
 * @param {string} root
 * @param {unknown} hostSessionId the Stop payload's `session_id`
 * @returns {{ id: string, session: Record<string, any> } | null}
 */
function resolveSession(root, hostSessionId) {
  const sessionsDir = path.join(root, '.forge', 'sessions');
  let names;
  try {
    names = fs.readdirSync(sessionsDir);
  } catch {
    return null;
  }
  const open = [];
  for (const name of names) {
    let session;
    try {
      session = readJson(path.join(sessionsDir, name, 'session.json'));
    } catch {
      continue; // unreadable: not ours to block on (fail open)
    }
    if (!session || typeof session !== 'object' || TERMINAL_PHASES.has(session.phase)) continue;
    open.push({ id: name, session });
  }

  const hostIds = (c) =>
    Array.isArray(c.session.host?.sessionIds) ? c.session.host.sessionIds : [];
  const host = typeof hostSessionId === 'string' && hostSessionId ? hostSessionId : null;
  if (host) {
    const mine = open.find((c) => hostIds(c).includes(host));
    if (mine) return mine;
  }
  // With a host id in hand, a session bound to other host sessions is theirs.
  const ours = host ? open.filter((c) => hostIds(c).length === 0) : open;

  let active = null;
  try {
    active = readJson(path.join(root, '.forge', 'active.json'))?.sessionId ?? null;
  } catch {
    // no usable pointer
  }
  const pointed = ours.find((c) => c.id === active);
  if (pointed) return pointed;
  return open.length === 1 && ours.length === 1 ? ours[0] : null;
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

  const resolved = resolveSession(REPO_ROOT, payload?.session_id);
  if (!resolved) process.exit(0);
  const { id: sessionId, session } = resolved;

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
  // `node` + `forge.mjs` (shell: false) on every platform — see resolve-forge.mjs.
  // FORGE_STOP_HOOK_FORGE_CMD still overrides for tests (quoted tokens).
  const { cmd, baseArgs } = resolveForgeInvocation({
    override: process.env.FORGE_STOP_HOOK_FORGE_CMD,
  });
  const r = spawnSync(cmd, [...baseArgs, 'integrity-check', '--session', sessionId], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    shell: false,
  });

  if (r.status === 0) {
    // Integrity is green, but a session ready to close with no `forge phase
    // done` is the stall: the turn ends on a summary and the session sits in
    // review forever. Nudge once per turn (stop_hook_active stops the loop).
    let finalReview = null;
    try {
      finalReview = fs.readFileSync(
        path.join(REPO_ROOT, '.forge', 'sessions', sessionId, 'reviews', 'final-review.md'),
        'utf8',
      );
    } catch {
      // No final review: only review/finish count as ready to close.
    }
    if (finalReview === null && session.phase !== 'review' && session.phase !== 'finish') {
      process.exit(0);
    }
    const head = (finalReview ?? '').split(/\r?\n/).slice(0, 20).join('\n');
    if (/\b(NOT READY|REJECTED)\b/.test(head)) process.exit(0);
    const done = `forge phase done --session ${sessionId}`;
    const reason =
      `Forge session ${sessionId} is at ${session.phase} and ready to close, but was never finished.\n` +
      `Finish now, in this turn (phases/finish.md): archive the change, then \`${done}\` and \`forge cleanup\`.\n` +
      `If only manual steps remain, run \`${done} --allow-incomplete "<what the user must do>"\` ` +
      'and tell the user what they still need to do.';
    process.stdout.write(`${JSON.stringify({ decision: 'block', reason })}\n`);
    process.exit(0);
  }

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
