import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runRecordEvidence } from './record-evidence.mjs';
import { leasePathFor } from './lib/lease.mjs';

const MODULE_URL = pathToFileURL(fileURLToPath(new URL('./lib/lease.mjs', import.meta.url))).href;
const FIXED_NOW = () => new Date('2026-06-05T15:04:22.000Z');
const SESSION = 'sess-lock';
const SLUG = 'lock-slug';
const HOLD_MS = 1500;

function makeFixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'forge-evlock-')));
  const sessionDir = path.join(dir, '.forge', 'sessions', SESSION);
  fs.mkdirSync(path.join(sessionDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge', 'active.json'), JSON.stringify({ sessionId: SESSION }), 'utf8');
  fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({ id: SESSION, slug: SLUG }), 'utf8');
  return { dir, ledger: path.join(sessionDir, 'verify-runs.jsonl') };
}

/** Tier-3 opts whose command records when it started into `marker`. */
function tier3Opts(overrides, marker, exitCode = 0) {
  return {
    task: null,
    command: null,
    exit: null,
    summary: null,
    tier: null,
    session: null,
    allowFail: false,
    forgeDir: null,
    noTdd: false,
    reason: null,
    help: false,
    tier3: true,
    cmdArgv: [
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(Date.now())); process.exit(${exitCode})`,
    ],
    env: { ...process.env, FORGEKIT_ALLOW_EXEC: '1' },
    confirm: false,
    ...overrides,
  };
}

/** Another process holds the lock for HOLD_MS, writes its release time to `releasedAt`, then releases. */
function holdFromChild(dir, releasedAt) {
  const code = `
    import(${JSON.stringify(MODULE_URL)}).then(({ acquireLease }) => {
      const release = acquireLease({ name: 'tier3', cwd: ${JSON.stringify(dir)}, sessionId: 'other-sess', slug: 'other-slug', pollMs: 25, notify: () => {} });
      console.log('held');
      setTimeout(() => {
        require('node:fs').writeFileSync(${JSON.stringify(releasedAt)}, String(Date.now()));
        release();
      }, ${HOLD_MS});
    });
  `;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const held = new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => {
      if (String(d).includes('held')) resolve();
    });
    child.on('exit', () => reject(new Error('child exited before holding the lock')));
  });
  return { child, held, exited };
}

test('scope group does not take the lock: it runs while another process holds it', async () => {
  const { dir, ledger } = makeFixture();
  const marker = path.join(dir, 'ran-group');
  const { child, held, exited } = holdFromChild(dir, path.join(dir, 'released-group'));
  await held;
  const t0 = Date.now();
  const res = runRecordEvidence(tier3Opts({ scope: 'group' }, marker), dir, FIXED_NOW);
  const elapsed = Date.now() - t0;
  assert.equal(res.exitCode, 0, res.message);
  assert.ok(elapsed < HOLD_MS / 2, `scoped run took ${elapsed}ms; it must not wait for the lock`);
  assert.equal(JSON.parse(fs.readFileSync(leasePathFor(dir, 'tier3'), 'utf8')).pid, child.pid, 'holder is untouched');
  assert.equal(JSON.parse(fs.readFileSync(ledger, 'utf8').trim()).scope, 'group');
  assert.equal(await exited, 0);
});

test('scope full waits for the holder, runs after it releases, stamps, and frees the lock', async () => {
  const { dir, ledger } = makeFixture();
  const marker = path.join(dir, 'ran-full');
  const releasedAt = path.join(dir, 'released-full');
  const { held, exited } = holdFromChild(dir, releasedAt);
  await held;
  const t0 = Date.now();
  const res = runRecordEvidence(tier3Opts({ scope: 'full' }, marker), dir, FIXED_NOW);
  const elapsed = Date.now() - t0;
  assert.equal(res.exitCode, 0, res.message);
  assert.ok(elapsed >= HOLD_MS / 2, `full run took ${elapsed}ms; it must wait for the holder`);
  const startedRunning = Number(fs.readFileSync(marker, 'utf8'));
  const released = Number(fs.readFileSync(releasedAt, 'utf8'));
  assert.ok(startedRunning >= released, 'command started before the holder released the lock');
  const stamp = JSON.parse(fs.readFileSync(ledger, 'utf8').trim());
  assert.equal(stamp.scope, 'full');
  assert.equal(stamp.ok, true);
  assert.equal(fs.existsSync(leasePathFor(dir, 'tier3')), false, 'lock is released after the run');
  assert.equal(await exited, 0);
});

test('the default scope is full and locks; a failing command still releases the lock', async () => {
  const { dir, ledger } = makeFixture();
  const marker = path.join(dir, 'ran-default');
  const releasedAt = path.join(dir, 'released-default');
  const { held, exited } = holdFromChild(dir, releasedAt);
  await held;
  const t0 = Date.now();
  const res = runRecordEvidence(tier3Opts({}, marker, 1), dir, FIXED_NOW);
  assert.ok(Date.now() - t0 >= HOLD_MS / 2, 'default (full) scope must wait');
  assert.equal(res.exitCode, 1);
  assert.equal(JSON.parse(fs.readFileSync(ledger, 'utf8').trim()).ok, false);
  assert.equal(fs.existsSync(leasePathFor(dir, 'tier3')), false, 'lock is released after a failing run');
  await exited;
});

test('the lock holder names the session slug read from session.json', async () => {
  const { dir } = makeFixture();
  const marker = path.join(dir, 'ran-holder');
  // The command itself reads the lock while the run holds it.
  const lock = leasePathFor(dir, 'tier3');
  const seen = path.join(dir, 'holder-seen.json');
  const opts = tier3Opts({}, marker);
  opts.cmdArgv = [
    process.execPath,
    '-e',
    `require('node:fs').copyFileSync(${JSON.stringify(lock)}, ${JSON.stringify(seen)})`,
  ];
  const res = runRecordEvidence(opts, dir, FIXED_NOW);
  assert.equal(res.exitCode, 0, res.message);
  const holder = JSON.parse(fs.readFileSync(seen, 'utf8'));
  assert.equal(holder.pid, process.pid);
  assert.equal(holder.sessionId, SESSION);
  assert.equal(holder.slug, SLUG);
});
