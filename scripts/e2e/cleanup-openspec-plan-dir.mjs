#!/usr/bin/env node
/**
 * Product loop for cleanup-openspec-plan-dir (F73) — drive the shipped forge
 * binary against a throwaway project: an aged unfinished plan-phase session
 * with only scaffold files survives bare cleanup when openspecChange points at
 * a live openspec/changes/<name>/ directory under an openspec-engine project
 * with no plan.dir.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FORGE_BIN = path.join(REPO, 'packages', 'cli', 'bin', 'forge.mjs');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-e2e-cleanup-openspec-plan-dir-'));
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
fs.writeFileSync(
  path.join(PROJECT, '.forge', 'config.json'),
  `${JSON.stringify({ plan: { engine: 'openspec' } })}\n`,
  'utf8',
);

const sessionDir = path.join(PROJECT, '.forge', 'sessions', SESSION_ID);
fs.mkdirSync(sessionDir, { recursive: true });
const old = new Date(Date.now() - 30 * 864e5).toISOString();
fs.writeFileSync(
  path.join(sessionDir, 'session.json'),
  `${JSON.stringify({
    id: SESSION_ID,
    slug: SESSION_ID,
    phase: 'plan',
    planType: 'openspec',
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

const changeDir = path.join(PROJECT, 'openspec', 'changes', CHANGE);
fs.mkdirSync(changeDir, { recursive: true });
fs.writeFileSync(path.join(changeDir, 'proposal.md'), '# why\n', 'utf8');

const bare = forge(PROJECT, ['cleanup']);
if (bare.code !== 0) fail(`forge cleanup failed: ${bare.stderr}`);
if (!fs.existsSync(sessionDir)) {
  fail('expected aged plan session with live openspec change dir to survive bare cleanup');
}

process.stdout.write('CLEANUP-OPENSPEC plan-retained=ok\n');
fs.rmSync(SCRATCH, { recursive: true, force: true });
