#!/usr/bin/env node
/**
 * Product loop for specs leftover sweep — drive the shipped forge binary
 * against a throwaway specs-engine project: a session at verify with
 * planType: specs refuses `forge phase review` without spec-verify.md, then
 * a report with Remaining: none lets review through.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FORGE_BIN = path.join(REPO, 'packages', 'cli', 'bin', 'forge.mjs');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-e2e-spec-leftover-gate-'));
const PROJECT = path.join(SCRATCH, 'project');
const SESSION_ID = 'spec-leftover';
const CHANGE = 'leftover-demo';

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
  `${JSON.stringify({ plan: { engine: 'specs' } })}\n`,
  'utf8',
);

const sessionDir = path.join(PROJECT, '.forge', 'sessions', SESSION_ID);
fs.mkdirSync(sessionDir, { recursive: true });
const now = new Date().toISOString();
fs.writeFileSync(
  path.join(sessionDir, 'session.json'),
  `${JSON.stringify(
    {
      id: SESSION_ID,
      slug: 'fixture',
      createdAt: now,
      updatedAt: now,
      phase: 'verify',
      planType: 'specs',
      openspecChange: CHANGE,
      forgeSkipped: false,
      cursorChatId: null,
      tasksTotal: 0,
      tasksComplete: 0,
    },
    null,
    2,
  )}\n`,
  'utf8',
);
fs.writeFileSync(
  path.join(PROJECT, '.forge', 'active.json'),
  `${JSON.stringify({ sessionId: SESSION_ID }, null, 2)}\n`,
  'utf8',
);

const missing = forge(PROJECT, ['phase', 'review']);
if (missing.code === 0) {
  fail('expected forge phase review to refuse without spec-verify.md');
}
if (!/spec-verify\.md/.test(missing.stderr)) {
  fail(`expected stderr to name spec-verify.md, got: ${missing.stderr}`);
}

fs.writeFileSync(
  path.join(sessionDir, 'spec-verify.md'),
  '## Forge disposition\n\n- Remaining: none\n',
  'utf8',
);

const ok = forge(PROJECT, ['phase', 'review']);
if (ok.code !== 0) {
  fail(`expected forge phase review to succeed after Remaining: none: ${ok.stderr}`);
}

process.stdout.write('SPEC LEFTOVER GATE GREEN\n');
fs.rmSync(SCRATCH, { recursive: true, force: true });
