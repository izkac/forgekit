#!/usr/bin/env node
/**
 * UserPromptSubmit: auto-triage substantial work into Forge (Claude Code).
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

function emit(message) {
  process.stdout.write(`<system-reminder>\n${message}\n</system-reminder>\n`);
}

function runForge(args) {
  return spawnSync('forge', args, {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    shell: true,
  });
}

const raw = await readStdin();
const prompt = extractPrompt(raw);
if (!prompt) process.exit(0);

const check = runForge(['triage', '--check', prompt]);
if (check.status !== 0) process.exit(0);

const hasSession = fs.existsSync(ACTIVE_FILE);
const args = ['triage', '--message'];
if (hasSession) args.push('--has-session');
args.push(prompt);

const msg = runForge(args);
if (msg.status === 0 && msg.stdout.trim()) {
  if (hasSession) {
    const rem = runForge(['reminder', '--format', 'plain']);
    if (rem.status === 0 && rem.stdout.trim()) {
      emit(`${msg.stdout.trim()}\n\nActive session:\n${rem.stdout.trim()}`);
      process.exit(0);
    }
  }
  emit(msg.stdout.trim());
}
