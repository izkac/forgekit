#!/usr/bin/env node
/**
 * Product loop for cleanup-plan-phase (F48) — drive the shipped forge binary
 * against a throwaway project: an aged unfinished plan-phase session with only
 * scaffold files survives bare cleanup when openspecChange points at a live
 * specs/changes/<name>/ directory; named `--include-unfinished --session`
 * still deletes it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FORGE_BIN = path.join(REPO, 'packages', 'cli', 'bin', 'forge.mjs');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-e2e-cleanup-plan-phase-'));
const PROJECT = path.join(SCRATCH, 'project');
const SESSION_ID = 'live-plan';
const CHANGE = 'example-change';

function forge(cwd, args) {
  const env = { ...process.env, FORGEKIT_FLEET_DIR: path.join(SCRATCH, '.fleet') };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CURSOR_CONVERSATION_ID;
  delete env.CURSOR_TRACE_ID;
  const r = spawnSync(process.execPath, [FORGE_BIN, ...args], { cwd, encoding: 'utf8', env });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(1);
}

fs.mkdirSync(path.join(PROJECT, '.forge'), { recursive: true });

const sessionDir = path.join(PROJECT, '.forge', 'sessions', SESSION_ID);
fs.mkdirSync(sessionDir, { recursive: true });
const old = new Date(Date.now() - 30 * 864e5).toISOString();
fs.writeFileSync(
  path.join(sessionDir, 'session.json'),
  `${JSON.stringify({
    id: SESSION_ID,
    slug: SESSION_ID,
    phase: 'plan',
    planType: 'specs',
    openspecChange: CHANGE,
    createdAt: old,
    updatedAt: old,
  })}\n`,
  'utf8',
);
fs.writeFileSync(path.join(sessionDir, 'status.json'), '{}\n', 'utf8');
for (const d of ['tasks', 'reviews', 'brainstorm']) {
  fs.mkdirSync(path.join(sessionDir, d), { recursive: true });
}

const changeDir = path.join(PROJECT, 'specs', 'changes', CHANGE);
fs.mkdirSync(changeDir, { recursive: true });
fs.writeFileSync(path.join(changeDir, 'proposal.md'), '# why\n', 'utf8');

const bare = forge(PROJECT, ['cleanup']);
if (bare.code !== 0) fail(`forge cleanup failed: ${bare.stderr}`);
if (!fs.existsSync(sessionDir)) {
  fail('expected aged plan session with live change dir to survive bare cleanup');
}

const named = forge(PROJECT, ['cleanup', '--include-unfinished', '--session', SESSION_ID]);
if (named.code !== 0) {
  fail(`forge cleanup --include-unfinished --session failed: ${named.stderr}`);
}
if (fs.existsSync(sessionDir)) {
  fail('expected named --include-unfinished --session to delete the plan session');
}

process.stdout.write('CLEANUP plan-retained=ok unfinished-delete=ok\n');
fs.rmSync(SCRATCH, { recursive: true, force: true });
