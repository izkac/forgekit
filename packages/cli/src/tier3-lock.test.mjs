import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireTier3Lock, lockPathFor } from './tier3-lock.mjs';

const MODULE_URL = pathToFileURL(fileURLToPath(new URL('./tier3-lock.mjs', import.meta.url))).href;
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
function holdFromChild(cwd, slug) {
  const code = `
    import(${JSON.stringify(MODULE_URL)}).then(({ acquireTier3Lock }) => {
      const release = acquireTier3Lock({ cwd: ${JSON.stringify(cwd)}, sessionId: 'child-sess', slug: ${JSON.stringify(slug)}, pollMs: ${POLL_MS}, notify: () => {} });
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

test('lockPathFor: non-git project uses .forge/tier3.lock', () => {
  const dir = tmp('forge-lock-nogit-');
  assert.equal(lockPathFor(dir), path.join(dir, '.forge', 'tier3.lock'));
});

test('lockPathFor: two worktrees of one repo resolve the same lock under the common git dir', () => {
  const root = tmp('forge-lock-wt-');
  const main = path.join(root, 'main');
  const second = path.join(root, 'second');
  fs.mkdirSync(main);
  git(main, 'init', '-q');
  fs.writeFileSync(path.join(main, 'f.txt'), 'x');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'init');
  git(main, 'worktree', 'add', '-q', second);
  const fromMain = lockPathFor(main);
  const fromSecond = lockPathFor(second);
  assert.equal(fromMain, path.join(main, '.git', 'forge', 'tier3.lock'));
  assert.equal(fromSecond, fromMain);
  // A subdirectory of a worktree resolves to the same lock too (git may print a relative path).
  fs.mkdirSync(path.join(second, 'sub'));
  assert.equal(lockPathFor(path.join(second, 'sub')), fromMain);
});

test('acquire writes the holder, release removes it, and release is idempotent', () => {
  const dir = tmp('forge-lock-basic-');
  const lock = lockPathFor(dir);
  const notes = [];
  const release = acquireTier3Lock({ cwd: dir, sessionId: 'sess-a', slug: 'slug-a', pollMs: POLL_MS, notify: (m) => notes.push(m) });
  const holder = JSON.parse(fs.readFileSync(lock, 'utf8'));
  assert.equal(holder.pid, process.pid);
  assert.equal(holder.sessionId, 'sess-a');
  assert.equal(holder.slug, 'slug-a');
  assert.equal(holder.cwd, dir);
  assert.ok(Number.isFinite(Date.parse(holder.startedAt)));
  assert.deepEqual(notes, []);
  release();
  assert.equal(fs.existsSync(lock), false);
  release();
  assert.equal(fs.existsSync(lock), false);
});

test('release never removes a lock that names another pid', () => {
  const dir = tmp('forge-lock-foreign-');
  const lock = lockPathFor(dir);
  const release = acquireTier3Lock({ cwd: dir, sessionId: 's', slug: 's', pollMs: POLL_MS, notify: () => {} });
  const other = { pid: process.pid + 1, sessionId: 'x', slug: 'x', cwd: dir, startedAt: new Date().toISOString() };
  fs.writeFileSync(lock, JSON.stringify(other));
  release();
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, 'utf8')), other);
});

test('waits while a live process holds the lock, names the holder, then proceeds after release', async () => {
  const dir = tmp('forge-lock-live-');
  const lock = lockPathFor(dir);
  const { child, held, exited } = holdFromChild(dir, 'holder-slug');
  await held;
  const notes = [];
  const t0 = Date.now();
  const release = acquireTier3Lock({ cwd: dir, sessionId: 'parent', slug: 'parent-slug', pollMs: POLL_MS, notify: (m) => notes.push(m) });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= HOLD_MS / 2, `waited ${elapsed}ms, expected at least ${HOLD_MS / 2}ms`);
  assert.equal(notes.length, 1, 'waiting notice is printed once, not per poll');
  assert.ok(notes[0].includes('holder-slug'), notes[0]);
  assert.ok(notes[0].includes(String(child.pid)), notes[0]);
  assert.match(notes[0], /waiting/);
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid);
  release();
  assert.equal(fs.existsSync(lock), false);
  assert.equal(await exited, 0);
});

test('takes over a lock whose holder pid is not running, without waiting', () => {
  const dir = tmp('forge-lock-dead-');
  const lock = lockPathFor(dir);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const dead = deadPid();
  fs.writeFileSync(lock, JSON.stringify({ pid: dead, sessionId: 'old', slug: 'old', cwd: dir, startedAt: new Date().toISOString() }));
  const notes = [];
  const t0 = Date.now();
  // pollMs far above the elapsed bound: if takeover waited one poll, the bound fails.
  const pollMs = 3000;
  const release = acquireTier3Lock({ cwd: dir, sessionId: 'new', slug: 'new', pollMs, notify: (m) => notes.push(m) });
  assert.ok(Date.now() - t0 < pollMs, 'dead holder must not cost a poll interval');
  assert.deepEqual(notes, []);
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid);
  release();
  assert.equal(fs.existsSync(lock), false);
});

test('takes over an unparseable lock once it is old, but not while it is fresh', async () => {
  const dir = tmp('forge-lock-garbage-');
  const lock = lockPathFor(dir);
  fs.mkdirSync(path.dirname(lock), { recursive: true });

  // Old garbage: stale.
  fs.writeFileSync(lock, '{not json');
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lock, old, old);
  const stale = acquireTier3Lock({ cwd: dir, sessionId: 'a', slug: 'a', pollMs: POLL_MS, notify: () => {} });
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid);
  stale();

  // Fresh garbage may be a live holder mid-write: keep waiting until it goes away.
  fs.writeFileSync(lock, '{not json');
  const remover = spawn(process.execPath, ['-e', `setTimeout(() => require('node:fs').unlinkSync(${JSON.stringify(lock)}), ${HOLD_MS})`], { stdio: 'ignore' });
  const exited = new Promise((resolve) => remover.on('exit', resolve));
  const notes = [];
  const t0 = Date.now();
  const fresh = acquireTier3Lock({ cwd: dir, sessionId: 'b', slug: 'b', pollMs: POLL_MS, notify: (m) => notes.push(m) });
  assert.ok(Date.now() - t0 >= HOLD_MS / 2, 'fresh unparseable lock must be waited on');
  assert.equal(notes.length, 1);
  fresh();
  await exited;
});

test('fails open when the lock cannot be created: warns naming the path, release is a no-op', () => {
  const dir = tmp('forge-lock-unwritable-');
  // `.forge` is a regular file, so its child cannot be created (portable; no chmod).
  fs.writeFileSync(path.join(dir, '.forge'), 'not a directory');
  const lock = lockPathFor(dir);
  const notes = [];
  const t0 = Date.now();
  const release = acquireTier3Lock({ cwd: dir, sessionId: 's', slug: 's', pollMs: 3000, notify: (m) => notes.push(m) });
  assert.ok(Date.now() - t0 < 3000, 'must not wait when the lock cannot be created');
  assert.equal(notes.length, 1);
  assert.ok(notes[0].includes(lock), notes[0]);
  assert.match(notes[0], /warning/i);
  assert.equal(typeof release, 'function');
  release();
  release();
  assert.equal(fs.readFileSync(path.join(dir, '.forge'), 'utf8'), 'not a directory');
});
