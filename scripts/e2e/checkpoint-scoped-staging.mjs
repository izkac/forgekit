#!/usr/bin/env node
/**
 * Product loop for checkpoint-scoped-staging (F72) — drive the shipped forge
 * binary against a throwaway git project: an untracked sibling change dir
 * under specs/changes/<other>/ must refuse checkpoint (no commit).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FORGE_BIN = path.join(REPO, 'packages', 'cli', 'bin', 'forge.mjs');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-e2e-checkpoint-scoped-staging-'));
const PROJECT = path.join(SCRATCH, 'project');
const SESSION_ID = 'ckpt-scoped';
const CHANGE = 'my-change';

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    process.stderr.write(`git ${args.join(' ')} failed: ${r.stderr}\n`);
    fs.rmSync(SCRATCH, { recursive: true, force: true });
    process.exit(1);
  }
  return (r.stdout ?? '').trim();
}

function forge(cwd, args) {
  const env = { ...process.env, FORGEKIT_FLEET_DIR: path.join(SCRATCH, '.fleet') };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CURSOR_CONVERSATION_ID;
  delete env.CURSOR_TRACE_ID;
  const r = spawnSync(process.execPath, [FORGE_BIN, ...args], { cwd, encoding: 'utf8', env });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(1);
}

fs.mkdirSync(PROJECT, { recursive: true });
git(PROJECT, ['init', '-q', '-b', 'main']);
git(PROJECT, ['config', 'user.email', 'e2e@example.com']);
git(PROJECT, ['config', 'user.name', 'E2E']);
fs.writeFileSync(path.join(PROJECT, 'README.md'), '# base\n', 'utf8');
git(PROJECT, ['add', '-A']);
git(PROJECT, ['commit', '-q', '-m', 'base']);
const baseSha = git(PROJECT, ['rev-parse', 'HEAD']);
git(PROJECT, ['checkout', '-q', '-b', 'feature-ckpt']);

fs.mkdirSync(path.join(PROJECT, '.forge'), { recursive: true });
fs.writeFileSync(
  path.join(PROJECT, '.forge', 'config.json'),
  `${JSON.stringify({
    plan: { engine: 'specs', dir: 'specs' },
    git: { checkpoint: 'per-group' },
  })}\n`,
  'utf8',
);

const sessionDir = path.join(PROJECT, '.forge', 'sessions', SESSION_ID);
fs.mkdirSync(sessionDir, { recursive: true });
const now = new Date().toISOString();
fs.writeFileSync(
  path.join(sessionDir, 'session.json'),
  `${JSON.stringify({
    id: SESSION_ID,
    slug: CHANGE,
    phase: 'implement',
    planType: 'specs',
    openspecChange: CHANGE,
    createdAt: now,
    updatedAt: now,
    baseCommit: baseSha,
    branch: 'feature-ckpt',
  })}\n`,
  'utf8',
);
fs.writeFileSync(
  path.join(PROJECT, '.forge', 'active.json'),
  `${JSON.stringify({ sessionId: SESSION_ID })}\n`,
  'utf8',
);

fs.appendFileSync(path.join(PROJECT, 'README.md'), 'edited\n');
const foreign = path.join(PROJECT, 'specs', 'changes', 'other-change', 'proposal.md');
fs.mkdirSync(path.dirname(foreign), { recursive: true });
fs.writeFileSync(foreign, '# foreign\n', 'utf8');

const blocked = forge(PROJECT, ['checkpoint', '--group', 'group-01']);
if (blocked.code === 0) {
  fail(`expected forge checkpoint to refuse foreign untracked; got ok:\n${blocked.stdout}`);
}
const combined = `${blocked.stderr}\n${blocked.stdout}`;
if (!/other-change/.test(combined)) {
  fail(`expected refusal to name foreign path; got:\n${combined}`);
}
if (git(PROJECT, ['rev-parse', 'HEAD']) !== baseSha) {
  fail('expected no commit when foreign untracked blocks checkpoint');
}

process.stdout.write('CHECKPOINT foreign-blocked=1\n');
fs.rmSync(SCRATCH, { recursive: true, force: true });
