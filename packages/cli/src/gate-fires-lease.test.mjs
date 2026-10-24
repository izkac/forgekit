import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readGateFires } from './gate-fires.mjs';

// Finding F1: lease-guard denials and lease-busy refusals are Gate fires too.

const BIN = fileURLToPath(new URL('../bin/forge.mjs', import.meta.url));
const LEASE_MODULE = pathToFileURL(fileURLToPath(new URL('./lib/lease.mjs', import.meta.url))).href;
const SESSION = 'sess-lease-fires';

/** Temp git project with an active session, a `db` lease matching `db-guarded`, and its own fires log. */
function project() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'forge-lease-fires-')));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir }).status, 0);
  const sessionDir = path.join(dir, '.forge', 'sessions', SESSION);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge', 'active.json'), JSON.stringify({ sessionId: SESSION }));
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    JSON.stringify({ id: SESSION, slug: 'lease-fires', phase: 'implement', createdAt: new Date().toISOString() }),
  );
  fs.writeFileSync(path.join(dir, '.forge', 'config.json'), JSON.stringify({ leases: { db: { match: ['db-guarded'], waitMs: 300 } } }));
  const home = fs.mkdtempSync(path.join(tmpdir(), 'forge-lease-fires-home-'));
  return { dir, fleet: path.join(home, 'sessions'), log: path.join(home, 'gate-fires.jsonl') };
}

function forge(p, args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: p.dir,
    encoding: 'utf8',
    env: { ...process.env, FORGEKIT_FLEET_DIR: p.fleet, FORGEKIT_ALLOW_EXEC: '1' },
    timeout: 60000,
  });
}

/** Another process holds lease `db` until killed. */
function holdDb(cwd) {
  const code = `import(${JSON.stringify(LEASE_MODULE)}).then(({ acquireLease }) => {
    acquireLease({ cwd: ${JSON.stringify(cwd)}, name: 'db', sessionId: 'other', slug: 'other', pollMs: 25, notify: () => {} });
    console.log('held');
    setTimeout(() => {}, 30000);
  });`;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  const held = new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => String(d).includes('held') && resolve());
    child.on('exit', () => reject(new Error('holder exited before taking the lease')));
  });
  return { child, held };
}

const gates = (p) => readGateFires(p.log).map((f) => f.gate);

test('a lease-guard deny (forge lease check) logs a lease-guard fire with the active session; none logs nothing', () => {
  const p = project();
  const none = forge(p, ['lease', 'check', '--command', 'npm test', '--json']);
  assert.equal(JSON.parse(none.stdout).action, 'none', none.stderr);
  assert.deepEqual(gates(p), []);
  const deny = forge(p, ['lease', 'check', '--command', 'npx db-guarded migrate', '--json']);
  assert.equal(JSON.parse(deny.stdout).action, 'deny', deny.stderr);
  const fires = readGateFires(p.log);
  assert.deepEqual(fires.map((f) => f.gate), ['lease-guard']);
  assert.equal(fires[0].sessionId, SESSION);
  assert.equal(fires[0].detail, 'db');
});

test('forge lease busy past the wait (exit 75) logs a lease-busy fire', async () => {
  const p = project();
  const { child, held } = holdDb(p.dir);
  try {
    await held;
    const r = forge(p, ['lease', 'db', '--wait-ms', '200', '--', process.execPath, '-e', '0']);
    assert.equal(r.status, 75, r.stderr);
  } finally {
    child.kill();
  }
  assert.deepEqual(gates(p), ['lease-busy']);
});

test('forge evidence refused on a busy lease logs lease-busy, not evidence', async () => {
  const p = project();
  const { child, held } = holdDb(p.dir);
  try {
    await held;
    const r = forge(p, ['evidence', '--task', '01-x', '--', process.execPath, '-e', '0', 'db-guarded']);
    assert.equal(r.status, 75, r.stderr);
  } finally {
    child.kill();
  }
  assert.deepEqual(gates(p), ['lease-busy']);
});
