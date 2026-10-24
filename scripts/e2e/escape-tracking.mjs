#!/usr/bin/env node
/**
 * Product loop for specs/changes/escape-tracking/e2e.json.
 *
 * Drives the SHIPPED binary against a scratch git project, with the fleet
 * registry (and so the gate-fires log beside it) pointed at a scratch home:
 *
 *   forge new → change commit (code + a plan doc naming price.js + a swept-in NOTES.md line)
 *   → refused `forge phase done` (a Gate fire)
 *   → `forge phase done --allow-incomplete` (records the Commit range)
 *   → fix commit rewriting a change line, and a later commit rewriting the swept-in line
 *   → `forge escapes list --json` names both: the fix has outsidePlan [], the sweep ['NOTES.md'] (F16)
 *   → `forge escapes confirm` the fix (replay test from the fix commit) → ledger line
 *   → `forge escapes dismiss` the sweep → nothing left undecided
 *   → `forge escapes report --json` rate 1, one byPace entry (the session's pace)
 *   → `forge fires --json` counts the refusal.
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
// Pin the plan dir (the user's default would otherwise decide it); written after `forge new`.
fs.writeFileSync(path.join(project, '.forge', 'config.json'), '{"plan":{"engine":"specs","dir":"specs"}}\n');
const head = commit(
  {
    'src/price.js': 'export const round = (x) => x;\nexport const total = (a, b) => a + b;\n',
    // the change's own plan names price.js, not NOTES.md
    'specs/changes/loop/tasks.md': '- [x] 1.1 add total to src/price.js\n',
    'NOTES.md': 'swept in: unrelated scratch line\n',
  },
  'feat: total',
);

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
// Same file, a line the change did not add: file overlap alone must not make a candidate.
commit(
  {
    'src/price.js': 'export const round = (x) => Math.round(x);\nexport const total = (a, b) => Number(a) + Number(b);\n',
  },
  'refactor: round',
  later,
);

// A later rewrite of the swept-in line, in a file the plan never names.
const sweep = commit({ 'NOTES.md': 'swept in: rewritten scratch line\n' }, 'chore: notes', later);

const listed = JSON.parse(forge(['escapes', 'list', '--json']).stdout);
const found = listed.sessions.flatMap((s) => s.candidates);
assert.deepEqual(found.map((c) => c.commit).sort(), [fix, sweep].sort(), 'only the fix and the sweep are Escape candidates');
assert.deepEqual(found.find((c) => c.commit === fix).outsidePlan, [], 'the fix hits a file the plan names');
assert.deepEqual(found.find((c) => c.commit === sweep).outsidePlan, ['NOTES.md'], 'the sweep hits only a file the plan never names');

forge(['escapes', 'confirm', sessionId, fix.slice(0, 8)]);
const decision = JSON.parse(fs.readFileSync(path.join(project, '.forge', 'escapes.jsonl'), 'utf8').trim());
assert.equal(decision.decision, 'confirmed');
assert.equal(decision.replayTest, 'test/price.test.js');
forge(['escapes', 'dismiss', sessionId, sweep.slice(0, 8), '--reason', 'F16 sweep']);
assert.deepEqual(JSON.parse(forge(['escapes', 'list', '--json']).stdout).sessions.flatMap((s) => s.candidates), []);

const report = JSON.parse(forge(['escapes', 'report', '--json']).stdout);
assert.equal(report.total.done, 1);
assert.equal(report.total.escaped, 1);
assert.equal(report.total.rate, 1);
assert.equal(report.byPace.length, 1, 'one pace recorded');
assert.equal(report.byPace[0].pace, row.pace || 'unknown', "byPace carries the digest row's pace");
assert.deepEqual([report.byPace[0].done, report.byPace[0].escaped, report.byPace[0].rate], [1, 1, 1]);

const fires = JSON.parse(forge(['fires', '--json']).stdout);
const doneFires = fires.gates.find((g) => g.gate === 'done:verify-evidence');
assert.equal(doneFires?.fires, 1, 'the refused done was logged once');
assert.ok(fires.unfired.includes('test-guard'), 'unfired gates are listed');

fs.rmSync(root, { recursive: true, force: true });
process.stdout.write('ESCAPE TRACKING GREEN\n');
