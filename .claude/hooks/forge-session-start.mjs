#!/usr/bin/env node
/**
 * Claude Code SessionStart: inject active Forge session when present.
 * Requires `forge` on PATH (npm link @izkac/forgekit or global install).
 */

import { spawnSync } from 'node:child_process';

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const r = spawnSync('forge', ['reminder', '--format', 'claude-session-start'], {
  encoding: 'utf8',
  cwd: REPO_ROOT,
  shell: true,
});

if (r.status === 0 && r.stdout.trim()) {
  process.stdout.write(r.stdout);
}
