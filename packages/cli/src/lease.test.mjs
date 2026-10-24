import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireLease, leasePathFor, listLeases, isValidLeaseName, LeaseBusyError } from './lib/lease.mjs';

const MODULE_URL = pathToFileURL(fileURLToPath(new URL('./lib/lease.mjs', import.meta.url))).href;
const HOLD_MS = 1500;
const POLL_MS = 25;

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

function git(cwd, ...args) {
  const res = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout;
}

/** A pid that belonged to a process that has exited. */
function deadPid() {
  const res = spawnSync(process.execPath, ['-e', '']);
  return res.pid;
}

/**
 * Child process that takes the lock through the module, reports `held`, keeps it
 * for HOLD_MS, then releases. Resolves once the child has reported `held`.
 */
function holdFromChild(cwd, slug, name = 'tier3') {
  const code = `
    import(${JSON.stringify(MODULE_URL)}).then(({ acquireLease }) => {
      const release = acquireLease({ cwd: ${JSON.stringify(cwd)}, name: ${JSON.stringify(name)}, sessionId: 'child-sess', slug: ${JSON.stringify(slug)}, pollMs: ${POLL_MS}, notify: () => {} });
      console.log('held');
      setTimeout(() => { release(); }, ${HOLD_MS});
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

test('leasePathFor: non-git project uses .forge/leases/tier3.lock', () => {
  const dir = tmp('forge-lock-nogit-');
  assert.equal(leasePathFor(dir, 'tier3'), path.join(dir, '.forge', 'leases', 'tier3.lock'));
});

test('leasePathFor: two worktrees of one repo resolve the same lock under the common git dir', () => {
  const root = tmp('forge-lock-wt-');
  const main = path.join(root, 'main');
  const second = path.join(root, 'second');
  fs.mkdirSync(main);
  git(main, 'init', '-q');
  fs.writeFileSync(path.join(main, 'f.txt'), 'x');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'init');
  git(main, 'worktree', 'add', '-q', second);
  const fromMain = leasePathFor(main, 'tier3');
  const fromSecond = leasePathFor(second, 'tier3');
  assert.equal(fromMain, path.join(main, '.git', 'forge', 'leases', 'tier3.lock'));
  assert.equal(fromSecond, fromMain);
  // A subdirectory of a worktree resolves to the same lock too (git may print a relative path).
  fs.mkdirSync(path.join(second, 'sub'));
  assert.equal(leasePathFor(path.join(second, 'sub'), 'tier3'), fromMain);
});

test('acquire writes the holder, release removes it, and release is idempotent', () => {
  const dir = tmp('forge-lock-basic-');
  const lock = leasePathFor(dir, 'tier3');
  const notes = [];
  const release = acquireLease({ name: 'tier3', cwd: dir, sessionId: 'sess-a', slug: 'slug-a', pollMs: POLL_MS, notify: (m) => notes.push(m) });
  const holder = JSON.parse(fs.readFileSync(lock, 'utf8'));
  assert.equal(holder.pid, process.pid);
  assert.equal(holder.sessionId, 'sess-a');
  assert.equal(holder.slug, 'slug-a');
  assert.equal(holder.cwd, dir);
  assert.equal(holder.name, 'tier3');
  assert.ok(Number.isFinite(Date.parse(holder.startedAt)));
  assert.deepEqual(notes, []);
  release();
  assert.equal(fs.existsSync(lock), false);
  release();
  assert.equal(fs.existsSync(lock), false);
});

test('release never removes a lock that names another pid', () => {
  const dir = tmp('forge-lock-foreign-');
  const lock = leasePathFor(dir, 'tier3');
  const release = acquireLease({ name: 'tier3', cwd: dir, sessionId: 's', slug: 's', pollMs: POLL_MS, notify: () => {} });
  const other = { pid: process.pid + 1, sessionId: 'x', slug: 'x', cwd: dir, startedAt: new Date().toISOString() };
  fs.writeFileSync(lock, JSON.stringify(other));
  release();
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, 'utf8')), other);
});

test('waits while a live process holds the lock, names the holder, then proceeds after release', async () => {
  const dir = tmp('forge-lock-live-');
  const lock = leasePathFor(dir, 'tier3');
  const { child, held, exited } = holdFromChild(dir, 'holder-slug');
  await held;
  const notes = [];
  const t0 = Date.now();
  const release = acquireLease({ name: 'tier3', cwd: dir, sessionId: 'parent', slug: 'parent-slug', pollMs: POLL_MS, notify: (m) => notes.push(m) });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= HOLD_MS / 2, `waited ${elapsed}ms, expected at least ${HOLD_MS / 2}ms`);
  assert.equal(notes.length, 1, 'waiting notice is printed once, not per poll');
  assert.ok(notes[0].includes('holder-slug'), notes[0]);
  assert.ok(notes[0].includes(String(child.pid)), notes[0]);
  assert.ok(notes[0].includes(lock), 'the notice names the lock file, the manual escape for a reused pid');
  assert.match(notes[0], /waiting/);
  assert.match(notes[0], /lease tier3/, 'the notice names the lease');
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid);
  release();
  assert.equal(fs.existsSync(lock), false);
  assert.equal(await exited, 0);
});

test('takes over a lock whose holder pid is not running, without waiting', () => {
  const dir = tmp('forge-lock-dead-');
  const lock = leasePathFor(dir, 'tier3');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const dead = deadPid();
  fs.writeFileSync(lock, JSON.stringify({ pid: dead, sessionId: 'old', slug: 'old', cwd: dir, startedAt: new Date().toISOString() }));
  const notes = [];
  const t0 = Date.now();
  // pollMs far above the elapsed bound: if takeover waited one poll, the bound fails.
  const pollMs = 3000;
  const release = acquireLease({ name: 'tier3', cwd: dir, sessionId: 'new', slug: 'new', pollMs, notify: (m) => notes.push(m) });
  assert.ok(Date.now() - t0 < pollMs, 'dead holder must not cost a poll interval');
  assert.deepEqual(notes, []);
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid);
  release();
  assert.equal(fs.existsSync(lock), false);
});

test('takes over an unparseable lock once it is old, but not while it is fresh', async () => {
  const dir = tmp('forge-lock-garbage-');
  const lock = leasePathFor(dir, 'tier3');
  fs.mkdirSync(path.dirname(lock), { recursive: true });

  // Old garbage: stale.
  fs.writeFileSync(lock, '{not json');
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lock, old, old);
  const stale = acquireLease({ name: 'tier3', cwd: dir, sessionId: 'a', slug: 'a', pollMs: POLL_MS, notify: () => {} });
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid);
  stale();

  // Fresh garbage may be a live holder mid-write: keep waiting until it goes away.
  fs.writeFileSync(lock, '{not json');
  const remover = spawn(process.execPath, ['-e', `setTimeout(() => require('node:fs').unlinkSync(${JSON.stringify(lock)}), ${HOLD_MS})`], { stdio: 'ignore' });
  const exited = new Promise((resolve) => remover.on('exit', resolve));
  const notes = [];
  const t0 = Date.now();
  const fresh = acquireLease({ name: 'tier3', cwd: dir, sessionId: 'b', slug: 'b', pollMs: POLL_MS, notify: (m) => notes.push(m) });
  assert.ok(Date.now() - t0 >= HOLD_MS / 2, 'fresh unparseable lock must be waited on');
  assert.equal(notes.length, 1);
  fresh();
  await exited;
});

test('fails open when the lock cannot be created: warns naming the path, release is a no-op', () => {
  const dir = tmp('forge-lock-unwritable-');
  // `.forge` is a regular file, so its child cannot be created (portable; no chmod).
  fs.writeFileSync(path.join(dir, '.forge'), 'not a directory');
  const lock = leasePathFor(dir, 'tier3');
  const notes = [];
  const t0 = Date.now();
  const release = acquireLease({ name: 'tier3', cwd: dir, sessionId: 's', slug: 's', pollMs: 3000, notify: (m) => notes.push(m) });
  assert.ok(Date.now() - t0 < 3000, 'must not wait when the lock cannot be created');
  assert.equal(notes.length, 1);
  assert.ok(notes[0].includes(lock), notes[0]);
  assert.match(notes[0], /warning/i);
  assert.equal(typeof release, 'function');
  release();
  release();
  assert.equal(fs.readFileSync(path.join(dir, '.forge'), 'utf8'), 'not a directory');
});

test('a named lease lives at leases/<name>.lock under the git common dir and records its name', () => {
  const root = tmp('forge-lease-named-');
  git(root, 'init', '-q');
  const lock = leasePathFor(root, 'db');
  assert.equal(lock, path.join(root, '.git', 'forge', 'leases', 'db.lock'));
  const release = acquireLease({ cwd: root, name: 'db', sessionId: 's', slug: 's', pollMs: POLL_MS, notify: () => {} });
  const holder = JSON.parse(fs.readFileSync(lock, 'utf8'));
  assert.equal(holder.name, 'db');
  assert.equal(holder.pid, process.pid);
  assert.equal(fs.existsSync(leasePathFor(root, 'tier3')), false, 'other names are untouched');
  release();
  assert.equal(fs.existsSync(lock), false);
});

test('two different lease names do not block each other', async () => {
  const dir = tmp('forge-lease-names-');
  const { held, exited } = holdFromChild(dir, 'db-holder', 'db');
  await held;
  const notes = [];
  const t0 = Date.now();
  const release = acquireLease({ cwd: dir, name: 'web', sessionId: 'p', slug: 'p', pollMs: 3000, notify: (m) => notes.push(m) });
  assert.ok(Date.now() - t0 < HOLD_MS / 2, 'a different name must be free while db is held');
  assert.deepEqual(notes, []);
  assert.equal(JSON.parse(fs.readFileSync(leasePathFor(dir, 'db'), 'utf8')).slug, 'db-holder', 'db is still held by the child');
  assert.equal(JSON.parse(fs.readFileSync(leasePathFor(dir, 'web'), 'utf8')).pid, process.pid);
  release();
  assert.equal(await exited, 0);
});

test('waitMs expiry throws LeaseBusyError carrying the lease and the live holder', async () => {
  const dir = tmp('forge-lease-busy-');
  const { child, held, exited } = holdFromChild(dir, 'busy-holder', 'db');
  await held;
  const waitMs = 300;
  const t0 = Date.now();
  let err;
  try {
    acquireLease({ cwd: dir, name: 'db', sessionId: 'p', slug: 'p', waitMs, pollMs: POLL_MS, notify: () => {} });
  } catch (e) {
    err = e;
  }
  const elapsed = Date.now() - t0;
  assert.ok(err instanceof LeaseBusyError, `expected LeaseBusyError, got ${err}`);
  assert.equal(err.name, 'LeaseBusyError');
  assert.equal(err.lease, 'db');
  assert.equal(err.holder.pid, child.pid);
  assert.equal(err.holder.slug, 'busy-holder');
  assert.ok(err.message.includes('db'), err.message);
  assert.ok(err.message.includes('busy-holder'), err.message);
  assert.ok(err.message.includes(String(child.pid)), err.message);
  assert.ok(err.message.includes(err.holder.startedAt), err.message);
  assert.ok(elapsed >= waitMs, `gave up after ${elapsed}ms, before waitMs ${waitMs}`);
  assert.ok(elapsed < HOLD_MS, `waited ${elapsed}ms, as long as the holder held it`);
  assert.equal(JSON.parse(fs.readFileSync(leasePathFor(dir, 'db'), 'utf8')).pid, child.pid, 'holder is untouched');
  assert.equal(await exited, 0);
});

test('a finite waitMs still acquires a free lease and a lease released within the wait', async () => {
  const dir = tmp('forge-lease-bounded-');
  const free = acquireLease({ cwd: dir, name: 'db', waitMs: 0, pollMs: POLL_MS, notify: () => {} });
  free();
  const { held, exited } = holdFromChild(dir, 'short-holder', 'db');
  await held;
  const release = acquireLease({ cwd: dir, name: 'db', waitMs: HOLD_MS * 10, pollMs: POLL_MS, notify: () => {} });
  assert.equal(JSON.parse(fs.readFileSync(leasePathFor(dir, 'db'), 'utf8')).pid, process.pid);
  release();
  await exited;
});

test('invalid lease names are rejected before the filesystem is touched', () => {
  const dir = tmp('forge-lease-invalid-');
  for (const name of ['../etc', 'Db', '-x', '', 'a/b', 'a.b', undefined, null, 42, '_slots']) {
    assert.equal(isValidLeaseName(name), false, `isValidLeaseName(${String(name)})`);
    assert.throws(
      () => acquireLease({ cwd: dir, name, pollMs: POLL_MS, notify: () => {} }),
      /lease name/i,
      `acquireLease(${String(name)})`,
    );
  }
  assert.equal(fs.existsSync(path.join(dir, '.forge')), false, 'nothing was created for an invalid name');
  assert.throws(() => leasePathFor(dir, '../etc'), /lease name/i);
});

test('_slots is an internal name: accepted only with internal, and public names are not internal', () => {
  assert.equal(isValidLeaseName('_slots', { internal: true }), true);
  assert.equal(isValidLeaseName('_slots'), false);
  assert.equal(isValidLeaseName('slots', { internal: true }), false);
  assert.equal(isValidLeaseName('_', { internal: true }), false);
  assert.equal(isValidLeaseName('db'), true);
  assert.equal(isValidLeaseName('db-2'), true);
  const dir = tmp('forge-lease-internal-');
  assert.throws(() => acquireLease({ cwd: dir, name: '_slots', notify: () => {} }), /lease name/i);
  const release = acquireLease({ cwd: dir, name: '_slots', internal: true, pollMs: POLL_MS, notify: () => {} });
  assert.equal(JSON.parse(fs.readFileSync(leasePathFor(dir, '_slots', { internal: true }), 'utf8')).name, '_slots');
  release();
});

test('listLeases: empty array when the leases dir does not exist', () => {
  const dir = tmp('forge-lease-list-none-');
  assert.deepEqual(listLeases(dir), []);
});

test('listLeases reports every *.lock with its holder and liveness, and ignores other files', async () => {
  const dir = tmp('forge-lease-list-');
  const { child, held, exited } = holdFromChild(dir, 'live-holder', 'db');
  await held;
  const dead = deadPid();
  const deadHolder = { name: 'old', pid: dead, sessionId: 'o', slug: 'dead-holder', cwd: dir, startedAt: new Date().toISOString() };
  fs.writeFileSync(leasePathFor(dir, 'old'), JSON.stringify(deadHolder));
  fs.writeFileSync(leasePathFor(dir, 'broken'), '{not json');
  fs.writeFileSync(path.join(path.dirname(leasePathFor(dir, 'old')), 'notes.txt'), 'not a lease');
  fs.writeFileSync(leasePathFor(dir, '_slots', { internal: true }), JSON.stringify({ name: '_slots', pid: child.pid }));

  const listed = listLeases(dir);
  assert.deepEqual(
    listed.map((l) => l.name),
    ['_slots', 'broken', 'db', 'old'],
    'every *.lock, sorted by name, nothing else',
  );
  const byName = Object.fromEntries(listed.map((l) => [l.name, l]));
  for (const l of listed) assert.equal(l.path, leasePathFor(dir, l.name, { internal: l.name.startsWith('_') }));
  assert.equal(byName.db.alive, true);
  assert.equal(byName.db.holder.pid, child.pid);
  assert.equal(byName.db.holder.slug, 'live-holder');
  assert.equal(byName.old.alive, false);
  assert.deepEqual(byName.old.holder, deadHolder);
  assert.equal(byName.broken.holder, null);
  assert.equal(byName.broken.alive, false);
  assert.equal(await exited, 0);
});
