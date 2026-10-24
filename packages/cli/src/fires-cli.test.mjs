import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GATE_IDS } from './gate-fires.mjs';

const FORGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'forge.mjs');

/** A fires log holding fires from two projects. */
function fixture() {
  const home = fs.mkdtempSync(path.join(tmpdir(), 'forge-fires-cli-'));
  const lines = [
    { gate: 'test-guard', sessionId: 'a', project: '/p/one', at: '2026-10-01T00:00:00.000Z' },
    { gate: 'test-guard', sessionId: 'b', project: '/p/two', at: '2026-10-05T00:00:00.000Z' },
    { gate: 'done:tasks', sessionId: 'b', project: '/p/two', at: '2026-10-06T00:00:00.000Z' },
  ];
  fs.writeFileSync(path.join(home, 'gate-fires.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return { home, fleet: path.join(home, 'sessions') };
}

function forge(f, args) {
  return spawnSync(process.execPath, [FORGE, 'fires', ...args], {
    cwd: f.home,
    encoding: 'utf8',
    env: { ...process.env, FORGEKIT_FLEET_DIR: f.fleet },
  });
}

test('forge fires --json counts per gate across projects and lists unfired gates at zero', () => {
  const f = fixture();
  const r = forge(f, ['--json']);
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  const byGate = Object.fromEntries(doc.gates.map((g) => [g.gate, g]));
  assert.equal(byGate['test-guard'].fires, 2);
  assert.equal(byGate['test-guard'].sessions, 2);
  assert.equal(byGate['done:tasks'].fires, 1);
  assert.equal(doc.gates.length, GATE_IDS.length);
  assert.equal(doc.unfired.length, GATE_IDS.length - 2);
  assert.equal(doc.projects, 2);
});

test('forge fires --since drops older fires', () => {
  const f = fixture();
  const doc = JSON.parse(forge(f, ['--json', '--since', '2026-10-02']).stdout);
  const byGate = Object.fromEntries(doc.gates.map((g) => [g.gate, g.fires]));
  assert.equal(byGate['test-guard'], 1);
});

test('forge fires prints a table naming every gate', () => {
  const f = fixture();
  const r = forge(f, []);
  assert.equal(r.status, 0, r.stderr);
  for (const id of GATE_IDS) assert.match(r.stdout, new RegExp(id.replace(/[:.-]/g, '\\$&')));
  assert.match(r.stdout, /never fired/i);
});
