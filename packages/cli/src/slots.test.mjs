import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { slotFor } from './lib/slots.mjs';

const BIN = fileURLToPath(new URL('../bin/forge.mjs', import.meta.url));
const LEASE_MODULE_URL = pathToFileURL(fileURLToPath(new URL('./lib/lease.mjs', import.meta.url))).href;

const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

/** A real repo with one commit; `addWorktree(name)` creates sibling linked worktrees in creation order. */
function makeRepo() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'forge-slots-')));
  made.push(base);
  const main = path.join(base, 'main');
  fs.mkdirSync(main);
  git(main, ['init', '-q']);
  git(main, ['config', 'user.email', 'slots@example.test']);
  git(main, ['config', 'user.name', 'slots']);
  git(main, ['commit', '-q', '--allow-empty', '-m', 'init']);
  const worktrees = [];
  const addWorktree = (name) => {
    const dir = path.join(base, name);
    git(main, ['worktree', 'add', '-q', '-b', `branch-${name}`, dir]);
    worktrees.push(dir);
    return dir;
  };
  const slotsFile = path.join(path.resolve(main, git(main, ['rev-parse', '--git-common-dir'])), 'forge', 'slots.json');
  return { base, main, worktrees, addWorktree, slotsFile };
}

const quiet = { notify: () => {} };

test('main worktree is slot 0 and allocates nothing', () => {
  const repo = makeRepo();
  assert.equal(slotFor(repo.main, quiet), 0);
  assert.equal(fs.existsSync(repo.slotsFile), false, 'the main worktree must not write slots.json');
});

test('a non-git directory is slot 0', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'forge-slots-nogit-')));
  made.push(dir);
  assert.equal(slotFor(dir, quiet), 0);
});

test('linked worktrees get 1, 2 in creation order and keep their slot', () => {
  const repo = makeRepo();
  const w1 = repo.addWorktree('w1');
  const w2 = repo.addWorktree('w2');
  // Expected numbers come from the creation order: the first linked worktree is 1, the next 2.
  assert.equal(slotFor(w1, quiet), repo.worktrees.indexOf(w1) + 1);
  assert.equal(slotFor(w2, quiet), repo.worktrees.indexOf(w2) + 1);
  assert.equal(slotFor(w1, quiet), repo.worktrees.indexOf(w1) + 1, 'W1 again must keep its slot');
  assert.equal(slotFor(repo.main, quiet), 0);
  // The slot is recorded under the shared git dir, one entry per linked worktree.
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(repo.slotsFile, 'utf8'))).length, repo.worktrees.length);
});

test('a subdirectory of a linked worktree resolves to the worktree slot', () => {
  const repo = makeRepo();
  const w1 = repo.addWorktree('w1');
  const w2 = repo.addWorktree('w2');
  const sub = path.join(w2, 'deep', 'er');
  fs.mkdirSync(sub, { recursive: true });
  // Slots are allocated on first ask, so ask in creation order.
  assert.equal(slotFor(w1, quiet), repo.worktrees.indexOf(w1) + 1);
  assert.equal(slotFor(sub, quiet), repo.worktrees.indexOf(w2) + 1);
});

test('a removed worktree frees its slot for the next one', () => {
  const repo = makeRepo();
  const w1 = repo.addWorktree('w1');
  const w2 = repo.addWorktree('w2');
  const slotW1 = slotFor(w1, quiet);
  const slotW2 = slotFor(w2, quiet);
  assert.notEqual(slotW1, slotW2);
  git(repo.main, ['worktree', 'remove', '--force', w1]);
  const w3 = repo.addWorktree('w3');
  assert.equal(slotFor(w3, quiet), slotW1, 'W3 must take the slot W1 freed');
  assert.equal(slotFor(w2, quiet), slotW2, 'W2 keeps its slot');
  const recorded = JSON.parse(fs.readFileSync(repo.slotsFile, 'utf8'));
  assert.equal(Object.keys(recorded).length, 2, 'the removed worktree must be pruned from slots.json');
});

test('entries for paths git no longer lists are pruned, even without a worktree remove', () => {
  const repo = makeRepo();
  const w1 = repo.addWorktree('w1');
  fs.mkdirSync(path.dirname(repo.slotsFile), { recursive: true });
  const ghost = path.join(repo.base, 'ghost-worktree');
  fs.writeFileSync(repo.slotsFile, JSON.stringify({ [ghost]: 1 }), 'utf8');
  assert.equal(slotFor(w1, quiet), 1, 'the ghost entry must not hold slot 1');
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(repo.slotsFile, 'utf8'))).includes(ghost), false);
});

test('an unreadable slots.json is rebuilt with one warning and the slot is stable', () => {
  const repo = makeRepo();
  const w1 = repo.addWorktree('w1');
  const w2 = repo.addWorktree('w2');
  slotFor(w1, quiet);
  slotFor(w2, quiet);
  for (const garbage of ['{ not json', '[1,2,3]']) {
    fs.writeFileSync(repo.slotsFile, garbage, 'utf8');
    const warnings = [];
    const first = slotFor(w2, { notify: (m) => warnings.push(m) });
    assert.equal(warnings.length, 1, `expected exactly one warning for ${garbage}: ${warnings.join(' | ')}`);
    assert.match(warnings[0], /slots\.json/);
    assert.match(warnings[0], /rebuilt/);
    assert.ok(Number.isInteger(first) && first >= 1);
    const again = [];
    assert.equal(slotFor(w2, { notify: (m) => again.push(m) }), first, 'the rebuilt slot must be stable');
    assert.deepEqual(again, [], 'the rewrite replaced the bad file, so no second warning');
  }
});

test('a differently-cased or backslash cwd maps to the same slot on Windows', { skip: process.platform !== 'win32' }, () => {
  const repo = makeRepo();
  const w1 = repo.addWorktree('w1');
  const expected = slotFor(w1, quiet);
  assert.equal(slotFor(w1.toUpperCase(), quiet), expected);
  assert.equal(slotFor(w1.replace(/\\/g, '/'), quiet), expected);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(repo.slotsFile, 'utf8'))).length, 1, 'one entry, not one per spelling');
});

/** Another process takes the `_slots` lease and keeps it for `holdMs`. */
function holdSlotsLease(cwd, holdMs) {
  const code = `
    import(${JSON.stringify(LEASE_MODULE_URL)}).then(({ acquireLease }) => {
      const release = acquireLease({ cwd: ${JSON.stringify(cwd)}, name: '_slots', internal: true, pollMs: 25, notify: () => {} });
      console.log('held');
      setTimeout(release, ${holdMs});
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
  return { held, exited };
}

test('a worktree that already has a slot returns without waiting for the _slots lease', async () => {
  const repo = makeRepo();
  const w1 = repo.addWorktree('w1');
  const slot = slotFor(w1, quiet);
  const holder = holdSlotsLease(repo.main, 3000);
  await holder.held;
  const start = Date.now();
  assert.equal(slotFor(w1, quiet), slot);
  const elapsed = Date.now() - start;
  await holder.exited;
  assert.ok(elapsed < 1500, `a known slot must not queue behind the lease (took ${elapsed} ms)`);
});

test('a first allocation waits for the lease but polls fast, not on the 5 s default', async () => {
  const repo = makeRepo();
  const w1 = repo.addWorktree('w1');
  const holder = holdSlotsLease(repo.main, 1500);
  await holder.held;
  const start = Date.now();
  const slot = slotFor(w1, quiet);
  const elapsed = Date.now() - start;
  await holder.exited;
  assert.equal(slot, repo.worktrees.indexOf(w1) + 1);
  assert.ok(elapsed >= 500, `the allocation must wait for the holder (took ${elapsed} ms)`);
  assert.ok(elapsed < 3500, `the allocation must notice the release quickly (took ${elapsed} ms)`);
});

test('concurrent `forge slot` in many worktrees yields distinct slots and a well-formed slots.json', async () => {
  const repo = makeRepo();
  const count = 8;
  const dirs = Array.from({ length: count }, (_, i) => repo.addWorktree(`c${i + 1}`));
  const runs = dirs.map(
    (dir) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [BIN, 'slot'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (err += d));
        child.on('error', reject);
        child.on('exit', (code) => resolve({ code, out, err }));
      }),
  );
  const results = await Promise.all(runs);
  for (const r of results) assert.equal(r.code, 0, r.err);
  const slots = results.map((r) => Number(r.out));
  assert.ok(slots.every((n) => Number.isInteger(n) && n >= 1), `slots: ${slots}`);
  assert.equal(new Set(slots).size, count, `duplicate slots: ${slots}`);
  const recorded = JSON.parse(fs.readFileSync(repo.slotsFile, 'utf8'));
  assert.equal(Object.keys(recorded).length, count);
  assert.deepEqual(Object.values(recorded).sort((a, b) => a - b), [...slots].sort((a, b) => a - b));
});

test('processes released at the same instant never share a slot (race on first allocation)', async () => {
  const repo = makeRepo();
  const count = 12;
  const dirs = Array.from({ length: count }, (_, i) => repo.addWorktree(`r${i + 1}`));
  const moduleUrl = pathToFileURL(fileURLToPath(new URL('./lib/slots.mjs', import.meta.url))).href;
  // Every child spins to the same wall-clock instant before asking, so the read-modify-write windows overlap.
  const startAt = Date.now() + 3000;
  const script = (dir) =>
    `import(${JSON.stringify(moduleUrl)}).then((m) => { while (Date.now() < ${startAt}); console.log(m.slotFor(${JSON.stringify(dir)}, { notify: () => {} })); });`;
  const slots = await Promise.all(
    dirs.map(
      (dir) =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['-e', script(dir)], { stdio: ['ignore', 'pipe', 'inherit'] });
          let out = '';
          child.stdout.on('data', (d) => (out += d));
          child.on('error', reject);
          child.on('exit', () => resolve(Number(out)));
        }),
    ),
  );
  assert.equal(new Set(slots).size, count, `duplicate slots: ${slots}`);
  const recorded = JSON.parse(fs.readFileSync(repo.slotsFile, 'utf8'));
  assert.equal(Object.keys(recorded).length, count);
});
