#!/usr/bin/env node
/**
 * Cursor sessionStart: remind when a Forge session is active (.forge/active.json).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function gitRoot() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) return null;
  return String(r.stdout || '').trim() || null;
}

const root = gitRoot();
if (!root) process.exit(0);

if (!fs.existsSync(path.join(root, '.forge', 'active.json'))) process.exit(0);

const reminder = spawnSync('forge', ['reminder', '--format', 'cursor'], {
  cwd: root,
  encoding: 'utf8',
  shell: process.platform === 'win32',
  stdio: ['ignore', 'inherit', 'ignore'],
});
process.exit(reminder.status === 0 ? 0 : 0);
