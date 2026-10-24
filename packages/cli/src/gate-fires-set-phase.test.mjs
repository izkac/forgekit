import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readGateFires } from './gate-fires.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'set-phase.mjs');

function fixture(session) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'forge-fires-phase-'));
  const id = 'sess-fires';
  const sessionDir = path.join(dir, '.forge', 'sessions', id);
  fs.mkdirSync(sessionDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify({ id, slug: 'fires', createdAt: now, updatedAt: now, phase: 'review', tasksTotal: 0, tasksComplete: 0, ...session }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(dir, '.forge', 'active.json'), `${JSON.stringify({ sessionId: id })}\n`);
  const home = fs.mkdtempSync(path.join(tmpdir(), 'forge-fires-phase-home-'));
  return { dir, id, sessionDir, fleet: path.join(home, 'sessions'), log: path.join(home, 'gate-fires.jsonl') };
}

function run(f, args) {
  const env = { ...process.env, FORGEKIT_FLEET_DIR: f.fleet };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_CONFIG_DIR;
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: f.dir, encoding: 'utf8', env });
}

test('a refused done logs one fire per failing sub-check, with the session id', () => {
  const f = fixture({ tasksTotal: 2, tasksComplete: 1 });
  const r = run(f, ['done']);
  assert.notEqual(r.status, 0, 'done must refuse');
  const fires = readGateFires(f.log);
  const gates = fires.map((x) => x.gate);
  assert.ok(gates.includes('done:verify-evidence'), gates.join(','));
  assert.ok(gates.includes('done:tasks'), gates.join(','));
  assert.equal(new Set(gates).size, gates.length, 'one line per sub-check');
  assert.ok(fires.every((x) => x.sessionId === f.id));
});

test('a done waived with --allow-incomplete is not a fire', () => {
  const f = fixture({ tasksTotal: 2, tasksComplete: 1 });
  const r = run(f, ['done', '--allow-incomplete', 'fixture']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readGateFires(f.log), []);
});

test('a passing transition logs nothing', () => {
  const f = fixture({});
  const r = run(f, ['verify']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readGateFires(f.log), []);
});

test('implement without a brief logs a brief fire', () => {
  const f = fixture({ phase: 'plan', planType: 'specs', openspecChange: 'c' });
  fs.mkdirSync(path.join(f.dir, 'specs', 'changes', 'c'), { recursive: true });
  fs.writeFileSync(path.join(f.dir, 'specs', 'changes', 'c', 'tasks.md'), '# Tasks\n');
  const r = run(f, ['implement']);
  assert.notEqual(r.status, 0);
  assert.deepEqual(readGateFires(f.log).map((x) => x.gate), ['brief']);
});

test('plan after brainstorm without notes logs a brainstorm-notes fire', () => {
  const f = fixture({ phase: 'brainstorm', phaseHistory: [{ phase: 'brainstorm', at: new Date().toISOString() }] });
  const r = run(f, ['plan']);
  assert.notEqual(r.status, 0);
  assert.deepEqual(readGateFires(f.log).map((x) => x.gate), ['brainstorm-notes']);
});
