#!/usr/bin/env node
/**
 * Product loop for specs/changes/escape-tracking/e2e.json.
 *
 * Drives the SHIPPED binary against a scratch git project, with the fleet
 * registry (and so the gate-fires log beside it) pointed at a scratch home:
 *
 *   forge new → change commit → refused `forge phase done` (a Gate fire)
 *   → `forge phase done --allow-incomplete` (records the Commit range)
 *   → fix commit rewriting a change line → `forge escapes list --json` names it
 *   → `forge escapes confirm` (replay test from the fix commit) → ledger line
 *   → `forge escapes report --json` rate 1 → `forge fires --json` counts the refusal.
 *
 * Prints ESCAPE TRACKING GREEN on success; exits 1 with the failing assertion otherwise.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FORGE_BIN = path.join(REPO, 'packages', 'cli', 'bin', 'forge.mjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-e2e-escapes-'));
const project = path.join(root, 'project');
const fleet = path.join(root, 'home', 'sessions');
fs.mkdirSync(project, { recursive: true });

const env = { ...process.env, FORGEKIT_FLEET_DIR: fleet };
for (const key of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CONFIG_DIR', 'CURSOR_CONVERSATION_ID', 'CURSOR_TRACE_ID']) delete env[key];

function forge(args, { ok = true } = {}) {
  const r = spawnSync(process.execPath, [FORGE_BIN, ...args], { cwd: project, encoding: 'utf8', env });
  if (ok && r.status !== 0) throw new Error(`forge ${args.join(' ')} exited ${r.status}\n${r.stderr}`);
  return r;
}

function git(args, at = null) {
  const e = at ? { ...env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : env;
  const r = spawnSync('git', args, { cwd: project, encoding: 'utf8', env: e });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(files, subject, at = null) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
    fs.writeFileSync(path.join(project, rel), text);
  }
  git(['add', '-A'], at);
  git(['commit', '-qm', subject], at);
  return git(['rev-parse', 'HEAD']);
}

git(['init', '-q']);
git(['config', 'user.email', 'e2e@forge']);
git(['config', 'user.name', 'e2e']);
fs.writeFileSync(path.join(project, '.gitignore'), '.forge/\n');
commit({ 'src/price.js': 'export const round = (x) => x;\n' }, 'base');

const created = JSON.parse(forge(['new', 'loop']).stdout);
const sessionId = created.sessionId;
const head = commit({ 'src/price.js': 'export const round = (x) => x;\nexport const total = (a, b) => a + b;\n' }, 'feat: total');

// A refused done is a Gate fire.
const refused = forge(['phase', 'done'], { ok: false });
assert.notEqual(refused.status, 0, 'done without verify evidence must refuse');

// A waived done records the Commit range.
forge(['phase', 'done', '--allow-incomplete', 'e2e: escape-tracking product loop']);
const row = fs
  .readFileSync(path.join(project, '.forge', 'sessions.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l))
  .find((r) => r.sessionId === sessionId);
assert.equal(row?.commitRange?.head, head, 'digest row carries the commit range head');

// A fix a minute later rewrites the line the change added, with its own test.
const later = new Date(Date.now() + 60000).toISOString();
const fix = commit(
  {
    'src/price.js': 'export const round = (x) => x;\nexport const total = (a, b) => Number(a) + Number(b);\n',
    'test/price.test.js': "import { total } from '../src/price.js';\n",
  },
  'fix: total concatenated strings',
  later,
);
commit({ 'README.md': 'docs\n' }, 'docs: unrelated', later);

const listed = JSON.parse(forge(['escapes', 'list', '--json']).stdout);
const candidates = listed.sessions.flatMap((s) => s.candidates.map((c) => c.commit));
assert.deepEqual(candidates, [fix], 'only the fix is an Escape candidate');

forge(['escapes', 'confirm', sessionId, fix.slice(0, 8)]);
const decision = JSON.parse(fs.readFileSync(path.join(project, '.forge', 'escapes.jsonl'), 'utf8').trim());
assert.equal(decision.decision, 'confirmed');
assert.equal(decision.replayTest, 'test/price.test.js');
assert.deepEqual(JSON.parse(forge(['escapes', 'list', '--json']).stdout).sessions.flatMap((s) => s.candidates), []);

const report = JSON.parse(forge(['escapes', 'report', '--json']).stdout);
assert.equal(report.total.done, 1);
assert.equal(report.total.escaped, 1);
assert.equal(report.total.rate, 1);

const fires = JSON.parse(forge(['fires', '--json']).stdout);
const doneFires = fires.gates.find((g) => g.gate === 'done:verify-evidence');
assert.equal(doneFires?.fires, 1, 'the refused done was logged once');
assert.ok(fires.unfired.includes('test-guard'), 'unfired gates are listed');

fs.rmSync(root, { recursive: true, force: true });
process.stdout.write('ESCAPE TRACKING GREEN\n');
