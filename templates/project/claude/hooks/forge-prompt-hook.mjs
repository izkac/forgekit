#!/usr/bin/env node
/**
 * UserPromptSubmit: when the user invokes /forge or /forge:*, inject session context.
 * Requires `forge` on PATH.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const ACTIVE_FILE = path.join(REPO_ROOT, '.forge', 'active.json');

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

function extractPrompt(raw) {
  if (!raw) return '';
  try {
    const j = JSON.parse(raw);
    return (
      (typeof j?.prompt === 'string' && j.prompt) ||
      (typeof j?.user_prompt === 'string' && j.user_prompt) ||
      (typeof j?.message === 'string' && j.message) ||
      ''
    );
  } catch {
    return raw;
  }
}

function isForgeInvocation(prompt) {
  return /^\s*\/forge(?::|\s|$)/i.test(prompt);
}

function emit(message) {
  process.stdout.write(`<system-reminder>\n${message}\n</system-reminder>\n`);
}

const raw = await readStdin();
const prompt = extractPrompt(raw);

if (!isForgeInvocation(prompt)) {
  process.exit(0);
}

if (!fs.existsSync(ACTIVE_FILE)) {
  emit(
    '[forge] No active session. Bootstrap with `forge new <slug>` then follow the Forge skill.',
  );
  process.exit(0);
}

const r = spawnSync('forge', ['reminder', '--format', 'plain', '--prompt', prompt], {
  encoding: 'utf8',
  cwd: REPO_ROOT,
  shell: true,
});

if (r.status === 0 && r.stdout.trim()) {
  emit(r.stdout.trim());
}
