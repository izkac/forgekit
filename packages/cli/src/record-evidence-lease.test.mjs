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
const SESSION = 'sess-lease';
const SLUG = 'lease-slug';
const HOLD_MS = 1500;
const TASK = '01-lease-task';

/** A project whose config guards commands containing `db-guarded` with lease `db`. */
function makeFixture(leases = { db: { match: ['db-guarded'] } }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'forge-evlease-')));
  const sessionDir = path.join(dir, '.forge', 'sessions', SESSION);
  fs.mkdirSync(path.join(sessionDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge', 'active.json'), JSON.stringify({ sessionId: SESSION }), 'utf8');
  fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({ id: SESSION, slug: SLUG }), 'utf8');
  fs.writeFileSync(path.join(dir, '.forge', 'config.json'), JSON.stringify({ leases }), 'utf8');
  return {
    dir,
    ledger: path.join(sessionDir, 'verify-runs.jsonl'),
    evidence: path.join(sessionDir, 'tasks', TASK, 'test-evidence.md'),
  };
}

/** Executed-evidence opts. The script text carries `tag`, which the fixture's patterns key on; it records its start time in `marker`. */
function opts({ tag, marker, extraJs = '', exitCode = 0, ...overrides }) {
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
    tier3: false,
    cmdArgv: [
      process.execPath,
      '-e',
      `/*${tag}*/ const fs=require('node:fs'); ${extraJs} fs.writeFileSync(${JSON.stringify(marker)}, String(Date.now())); process.exit(${exitCode})`,
    ],
    env: { ...process.env, FORGEKIT_ALLOW_EXEC: '1' },
    confirm: false,
    ...overrides,
  };
}

/**
 * Another process holds lease `name` for HOLD_MS, writes its release time to `releasedAt`, then releases.
 * With `probeLock`, halfway through it also records whether that lock file exists (to `<releasedAt>.probe`).
 */
function holdFromChild(dir, name, releasedAt, probeLock = null) {
  const code = `
    import(${JSON.stringify(MODULE_URL)}).then(({ acquireLease }) => {
      const release = acquireLease({ name: ${JSON.stringify(name)}, cwd: ${JSON.stringify(dir)}, sessionId: 'other-sess', slug: 'other-slug', pollMs: 25, notify: () => {} });
      console.log('held');
      ${probeLock ? `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(`${releasedAt}.probe`)}, String(require('node:fs').existsSync(${JSON.stringify(probeLock)}))), ${HOLD_MS / 2});` : ''}
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
    child.on('exit', () => reject(new Error('child exited before holding the lease')));
  });
  return { child, held, exited };
}

test('a held db lease delays a matching --tier3 --scope group run until it is released', async () => {
  const { dir, ledger } = makeFixture();
  const marker = path.join(dir, 'ran');
  const releasedAt = path.join(dir, 'released');
  const { held, exited } = holdFromChild(dir, 'db', releasedAt);
  await held;
  const t0 = Date.now();
  const res = runRecordEvidence(opts({ tag: 'db-guarded', marker, tier3: true, scope: 'group' }), dir, FIXED_NOW);
  const elapsed = Date.now() - t0;
  assert.equal(res.exitCode, 0, res.message);
  assert.ok(elapsed >= HOLD_MS / 2, `matching run took ${elapsed}ms; it must wait for the db holder`);
  assert.ok(Number(fs.readFileSync(marker, 'utf8')) >= Number(fs.readFileSync(releasedAt, 'utf8')), 'command started before the holder released db');
  assert.equal(JSON.parse(fs.readFileSync(ledger, 'utf8').trim()).scope, 'group');
  assert.equal(fs.existsSync(leasePathFor(dir, 'db')), false, 'db is released after the run');
  assert.equal(await exited, 0);
});

test('a non-matching command runs without waiting while db is held', async () => {
  const { dir, ledger } = makeFixture();
  const marker = path.join(dir, 'ran');
  const { child, held, exited } = holdFromChild(dir, 'db', path.join(dir, 'released'));
  await held;
  const t0 = Date.now();
  const res = runRecordEvidence(opts({ tag: 'something-else', marker, tier3: true, scope: 'group' }), dir, FIXED_NOW);
  const elapsed = Date.now() - t0;
  assert.equal(res.exitCode, 0, res.message);
  assert.ok(elapsed < HOLD_MS / 2, `non-matching run took ${elapsed}ms; it must not wait`);
  assert.equal(JSON.parse(fs.readFileSync(leasePathFor(dir, 'db'), 'utf8')).pid, child.pid, 'holder is untouched');
  assert.equal(JSON.parse(fs.readFileSync(ledger, 'utf8').trim()).ok, true);
  assert.equal(await exited, 0);
});

test('a busy db lease with waitMs 300 makes a matching tier-3 run exit 75, naming the lease, with no stamp and no command run', async () => {
  const { dir, ledger } = makeFixture({ db: { match: ['db-guarded'], waitMs: 300 } });
  const marker = path.join(dir, 'ran');
  // A pre-existing ledger line proves nothing new is appended.
  const before = `${JSON.stringify({ scope: 'group', command: 'earlier', exit: 0, ok: true })}\n`;
  fs.writeFileSync(ledger, before, 'utf8');
  const { child, held, exited } = holdFromChild(dir, 'db', path.join(dir, 'released'));
  await held;
  const t0 = Date.now();
  const res = runRecordEvidence(opts({ tag: 'db-guarded', marker, tier3: true, scope: 'full' }), dir, FIXED_NOW);
  const elapsed = Date.now() - t0;
  assert.equal(res.exitCode, 75, res.message);
  assert.ok(res.message.includes('db'), res.message);
  assert.ok(res.message.includes('other-slug'), res.message);
  assert.ok(res.message.includes(String(child.pid)), res.message);
  assert.ok(elapsed >= 300 && elapsed < HOLD_MS, `gave up after ${elapsed}ms`);
  assert.equal(fs.existsSync(marker), false, 'the command ran although db was busy');
  assert.equal(fs.readFileSync(ledger, 'utf8'), before, 'a busy lease must not stamp');
  assert.equal(fs.existsSync(leasePathFor(dir, 'tier3')), false, 'tier3 was not left held');
  assert.equal(JSON.parse(fs.readFileSync(leasePathFor(dir, 'db'), 'utf8')).pid, child.pid, 'holder is untouched');
  assert.equal(await exited, 0);
});

test('the task-evidence executed path waits for, and fails on, a busy matching lease the same way', async () => {
  const waiting = makeFixture();
  const markerW = path.join(waiting.dir, 'ran');
  const releasedAt = path.join(waiting.dir, 'released');
  const a = holdFromChild(waiting.dir, 'db', releasedAt);
  await a.held;
  const t0 = Date.now();
  const resW = runRecordEvidence(opts({ tag: 'db-guarded', marker: markerW, task: TASK }), waiting.dir, FIXED_NOW);
  assert.equal(resW.exitCode, 0, resW.message);
  assert.ok(Date.now() - t0 >= HOLD_MS / 2, 'task-evidence run must wait for the db holder');
  assert.ok(Number(fs.readFileSync(markerW, 'utf8')) >= Number(fs.readFileSync(releasedAt, 'utf8')), 'command started before the holder released db');
  assert.ok(fs.existsSync(waiting.evidence), 'evidence is written after the wait');
  assert.equal(await a.exited, 0);

  const busy = makeFixture({ db: { match: ['db-guarded'], waitMs: 300 } });
  const markerB = path.join(busy.dir, 'ran');
  const b = holdFromChild(busy.dir, 'db', path.join(busy.dir, 'released'));
  await b.held;
  const resB = runRecordEvidence(opts({ tag: 'db-guarded', marker: markerB, task: TASK }), busy.dir, FIXED_NOW);
  assert.equal(resB.exitCode, 75, resB.message);
  assert.ok(resB.message.includes('db'), resB.message);
  assert.equal(fs.existsSync(markerB), false, 'the command ran although db was busy');
  assert.equal(fs.existsSync(busy.evidence), false, 'a busy lease must not write evidence');
  assert.equal(await b.exited, 0);
});

test('matching leases are held together with tier3 while the command runs, and all released after', () => {
  const { dir, ledger } = makeFixture({ alpha: { match: ['both-guarded'] }, db: { match: ['both-guarded'] } });
  const marker = path.join(dir, 'ran');
  const seen = path.join(dir, 'seen.json');
  const locks = ['alpha', 'db', 'tier3'].map((n) => leasePathFor(dir, n));
  const extraJs = `fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify(${JSON.stringify(locks)}.map((f) => fs.existsSync(f))));`;
  const res = runRecordEvidence(opts({ tag: 'both-guarded', marker, extraJs, tier3: true, scope: 'full' }), dir, FIXED_NOW);
  assert.equal(res.exitCode, 0, res.message);
  assert.deepEqual(JSON.parse(fs.readFileSync(seen, 'utf8')), [true, true, true], 'alpha, db and tier3 are all held while the command runs');
  for (const lock of locks) assert.equal(fs.existsSync(lock), false, `${lock} released after the run`);
  assert.equal(JSON.parse(fs.readFileSync(ledger, 'utf8').trim()).ok, true);
});

test('a busy later lease releases an earlier one already taken, and nothing is stamped', async () => {
  const { dir, ledger } = makeFixture({ alpha: { match: ['both-guarded'], waitMs: 300 }, db: { match: ['both-guarded'], waitMs: 300 } });
  const marker = path.join(dir, 'ran');
  const { child, held, exited } = holdFromChild(dir, 'db', path.join(dir, 'released'));
  await held;
  const res = runRecordEvidence(opts({ tag: 'both-guarded', marker, tier3: true, scope: 'full' }), dir, FIXED_NOW);
  assert.equal(res.exitCode, 75, res.message);
  assert.ok(res.message.includes('db'), res.message);
  assert.equal(fs.existsSync(leasePathFor(dir, 'alpha')), false, 'alpha (taken first) must be released when db is busy');
  assert.equal(fs.existsSync(leasePathFor(dir, 'tier3')), false);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(ledger), false, 'no ledger line');
  assert.equal(JSON.parse(fs.readFileSync(leasePathFor(dir, 'db'), 'utf8')).pid, child.pid);
  assert.equal(await exited, 0);
});

test('leases are taken in name order: alpha is already held while the run waits for db', async () => {
  const { dir } = makeFixture({ alpha: { match: ['both-guarded'] }, db: { match: ['both-guarded'] } });
  const marker = path.join(dir, 'ran');
  const releasedAt = path.join(dir, 'released');
  const { held, exited } = holdFromChild(dir, 'db', releasedAt, leasePathFor(dir, 'alpha'));
  await held;
  const res = runRecordEvidence(opts({ tag: 'both-guarded', marker, tier3: true, scope: 'group' }), dir, FIXED_NOW);
  assert.equal(res.exitCode, 0, res.message);
  assert.equal(fs.readFileSync(`${releasedAt}.probe`, 'utf8'), 'true', 'alpha was not held while waiting for db: wrong acquisition order');
  assert.equal(await exited, 0);
});
