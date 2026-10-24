import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readGateFires } from './gate-fires.mjs';
import { runEnforceModel } from './enforce-model.mjs';

const SRC = path.dirname(fileURLToPath(import.meta.url));

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Scratch git project with one committed test file and a session at `phase`. */
function fixture(phase = 'implement') {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'forge-fires-sites-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.test.js'), 'x\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  const id = 'sess-sites';
  const sessionDir = path.join(dir, '.forge', 'sessions', id);
  fs.mkdirSync(sessionDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify({ id, slug: 'sites', createdAt: now, updatedAt: now, phase, baseCommit: git(dir, 'rev-parse', 'HEAD'), tasksTotal: 0, tasksComplete: 0 }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(dir, '.forge', 'active.json'), `${JSON.stringify({ sessionId: id })}\n`);
  const home = fs.mkdtempSync(path.join(tmpdir(), 'forge-fires-sites-home-'));
  return { dir, id, fleet: path.join(home, 'sessions'), log: path.join(home, 'gate-fires.jsonl') };
}

function run(f, script, args, env = {}) {
  const base = { ...process.env, FORGEKIT_FLEET_DIR: f.fleet, ...env };
  delete base.CLAUDE_CODE_SESSION_ID;
  return spawnSync(process.execPath, [path.join(SRC, script), ...args], { cwd: f.dir, encoding: 'utf8', env: base });
}

const gates = (f) => readGateFires(f.log).map((x) => x.gate);

test('a failing integrity-check logs an integrity-check fire', () => {
  const f = fixture();
  const r = run(f, 'integrity-check.mjs', []);
  assert.equal(r.status, 1, 'no spine → integrity problems');
  assert.deepEqual(gates(f), ['integrity-check']);
  assert.equal(readGateFires(f.log)[0].sessionId, f.id);
});

test('a guard deny logs a test-guard fire; an allow logs nothing', () => {
  const f = fixture();
  const allow = run(f, 'guard-cli.mjs', ['check', '--file', 'other.js']);
  assert.equal(allow.status, 0, allow.stderr);
  assert.deepEqual(gates(f), []);
  const deny = run(f, 'guard-cli.mjs', ['check', '--file', 'a.test.js']);
  assert.equal(deny.status, 2, deny.stderr);
  assert.deepEqual(gates(f), ['test-guard']);
});

test('a contradicted tdd expectation logs a tdd-expectation fire; a met one logs nothing', () => {
  const f = fixture();
  const env = { FORGEKIT_ALLOW_EXEC: '1' };
  const ok = run(f, 'tdd-run.mjs', ['run', '--task', '01-x', '--expect', 'fail', '--', process.execPath, '-e', 'process.exit(1)'], env);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(gates(f), []);
  const bad = run(f, 'tdd-run.mjs', ['run', '--task', '01-x', '--expect', 'fail', '--', process.execPath, '-e', 'process.exit(0)'], env);
  assert.equal(bad.status, 1);
  assert.deepEqual(gates(f), ['tdd-expectation']);
});

test('a refused tdd exec logs an exec-gate fire', () => {
  const f = fixture();
  const env = { FORGEKIT_ALLOW_EXEC: '' };
  const r = spawnSync(
    process.execPath,
    [path.join(SRC, 'tdd-run.mjs'), 'run', '--task', '01-x', '--expect', 'fail', '--', process.execPath, '-e', '0'],
    { cwd: f.dir, encoding: 'utf8', env: { ...process.env, FORGEKIT_FLEET_DIR: f.fleet, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(gates(f), ['exec-gate']);
});

test('a refused forge evidence logs an evidence fire', () => {
  const f = fixture();
  const r = run(f, 'record-evidence.mjs', ['--task', '01-x', '--command', 'npm test', '--exit', '1', '--summary', 'red']);
  assert.equal(r.status, 1, 'non-zero --exit without --allow-fail is refused');
  assert.deepEqual(gates(f), ['evidence']);
});

test('a model-policy deny logs a model-policy fire', async () => {
  const f = fixture();
  fs.writeFileSync(
    path.join(f.dir, '.forge', 'models.local.json'),
    `${JSON.stringify({ tiers: { fast: 'haiku', standard: 'sonnet', capable: 'opus' } })}\n`,
  );
  const prev = process.env.FORGEKIT_FLEET_DIR;
  process.env.FORGEKIT_FLEET_DIR = f.fleet;
  try {
    let out = '';
    await runEnforceModel(['--agent', 'claude-code', '--forge-dir', path.join(f.dir, '.forge')], {
      cwd: f.dir,
      input: JSON.stringify({ tool_name: 'Agent', tool_input: { description: 'x', prompt: 'y', model: 'not-a-model' } }),
      stdout: { write: (s) => (out += s) },
    });
    assert.match(out, /"deny"/, out);
  } finally {
    if (prev === undefined) delete process.env.FORGEKIT_FLEET_DIR;
    else process.env.FORGEKIT_FLEET_DIR = prev;
  }
  assert.deepEqual(gates(f), ['model-policy']);
});
