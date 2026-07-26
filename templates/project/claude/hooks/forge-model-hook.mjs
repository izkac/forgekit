#!/usr/bin/env node
/**
 * PreToolUse (subagent dispatch): enforce .forge/models.local.json.
 *
 * Thin shell around `forge enforce-model` — the decision lives there, this only
 * carries the payload across and stays out of the way when it can't. A project
 * with no models.local.json is unaffected.
 *
 * Requires `forge` on PATH; without it the hook is silent rather than noisy,
 * because a policy hook must never stand between a coordinator and its work.
 */

import { spawnSync } from 'node:child_process';

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

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

const raw = await readStdin();
if (!raw) process.exit(0);

const r = spawnSync('forge', ['enforce-model'], {
  input: raw,
  encoding: 'utf8',
  cwd: REPO_ROOT,
  shell: true,
});

if (r.status === 0 && r.stdout && r.stdout.trim()) {
  process.stdout.write(r.stdout.trim());
}
process.exit(0);
