#!/usr/bin/env node
/**
 * Claude Code SessionStart: inject active Forge session when present.
 * Requires `forge` on PATH (npm link @izkac/forgekit or global install).
 */

import { spawnSync } from 'node:child_process';
import { resolveForgeInvocation } from './resolve-forge.mjs';

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const { cmd, baseArgs } = resolveForgeInvocation();
const r = spawnSync(cmd, [...baseArgs, 'reminder', '--format', 'claude-session-start'], {
  encoding: 'utf8',
  cwd: REPO_ROOT,
  shell: false,
});

if (r.status === 0 && r.stdout.trim()) {
  process.stdout.write(r.stdout);
}
