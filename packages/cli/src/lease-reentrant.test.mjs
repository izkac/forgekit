import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { leasePathFor } from './lib/lease.mjs';

const BIN = fileURLToPath(new URL('../bin/forge.mjs', import.meta.url));
const MODULE_URL = pathToFileURL(fileURLToPath(new URL('./lib/lease.mjs', import.meta.url))).href;
const HELD = 'FORGE_LEASES_HELD';
const SESSION = 'sess-reentrant';
const INNER_WAIT_MS = 5000;

/** A temp git project with an active session; `db` is configured to guard commands containing `db-guarded`. */
function makeProject() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'forge-reentrant-')));
  const git = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  const sessionDir = path.join(dir, '.forge', 'sessions', SESSION);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge', 'active.json'), JSON.stringify({ sessionId: SESSION }), 'utf8');
  fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({ id: SESSION, slug: 'reentrant-slug' }), 'utf8');
  fs.writeFileSync(path.join(dir, '.forge', 'config.json'), JSON.stringify({ leases: { db: { match: ['db-guarded'], waitMs: 3000 } } }), 'utf8');
  return { dir, lock: leasePathFor(dir, 'db'), ledger: path.join(sessionDir, 'verify-runs.jsonl') };
}

function forge(dir, args, env = {}, timeout = 90000) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, FORGEKIT_ALLOW_EXEC: '1', ...env },
    timeout,
  });
}

/** Write a node script into `dir` and return its path. */
function script(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

/** JS prelude: `readPid()` returns the pid the `db` lock file currently names, or null. */
function prelude(lock) {
  return `const fs = require('node:fs'); const { spawnSync } = require('node:child_process');
const readPid = () => { try { return JSON.parse(fs.readFileSync(${JSON.stringify(lock)}, 'utf8')).pid; } catch { return null; } };\n`;
}

/** Another process holds `db` for holdMs through the module. */
function holdFromChild(cwd, holdMs = 8000) {
  const code = `
    import(${JSON.stringify(MODULE_URL)}).then(({ acquireLease }) => {
      const release = acquireLease({ cwd: ${JSON.stringify(cwd)}, name: 'db', sessionId: 'a-sess', slug: 'holder-a', pollMs: 25, notify: () => {} });
      console.log('held');
      setTimeout(() => { release(); }, ${holdMs});
    });
  `;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  const held = new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => {
      if (String(d).includes('held')) resolve();
    });
    child.on('exit', () => reject(new Error('child exited before holding the lease')));
  });
  return { child, held };
}

test('a wrapped script matched by its own lease runs its inner `forge lease` at once, and the outer keeps the lock throughout', () => {
  const { dir, lock } = makeProject();
  const probeOut = path.join(dir, 'probe.json');
  const outerOut = path.join(dir, 'outer.json');
  const probe = script(dir, 'probe.js', `${prelude(lock)}fs.writeFileSync(${JSON.stringify(probeOut)}, JSON.stringify({ pid: readPid(), held: process.env.${HELD} }));`);
  const outer = script(
    dir,
    'outer.js',
    `${prelude(lock)}const before = readPid(); const t0 = Date.now();
const r = spawnSync(process.execPath, [${JSON.stringify(BIN)}, 'lease', 'db', '--wait-ms', '${INNER_WAIT_MS}', '--', process.execPath, ${JSON.stringify(probe)}], { stdio: 'inherit', env: process.env });
fs.writeFileSync(${JSON.stringify(outerOut)}, JSON.stringify({ before, after: readPid(), status: r.status, elapsed: Date.now() - t0, held: process.env.${HELD} }));`,
  );

  const res = forge(dir, ['lease', 'db', '--', process.execPath, outer], { [HELD]: '' });
  assert.equal(res.status, 0, res.stderr);
  const o = JSON.parse(fs.readFileSync(outerOut, 'utf8'));
  const p = JSON.parse(fs.readFileSync(probeOut, 'utf8'));
  assert.equal(o.status, 0, `inner forge lease db failed (it waited on its own parent?): ${res.stderr}`);
  assert.ok(o.elapsed < INNER_WAIT_MS, `inner took ${o.elapsed}ms: it waited`);
  assert.equal(typeof o.before, 'number', 'the outer lease names a pid while its command runs');
  assert.notEqual(o.before, process.pid);
  assert.equal(p.pid, o.before, 'while the inner command runs, db.lock still names the outer holder');
  assert.equal(o.after, o.before, 'the inner call must not release the outer lease');
  assert.equal(o.held, `db:${o.before}`, 'the outer command sees the lease it runs under');
  assert.equal(p.held, `db:${o.before}`, 'the re-entrant inner call exports no second entry for the same lease');
  assert.equal(fs.existsSync(lock), false, 'the lock goes away only when the outer exits');
});

test('FORGE_LEASES_HELD is appended to an inherited value', () => {
  const { dir, lock } = makeProject();
  const out = path.join(dir, 'probe.json');
  const probe = script(dir, 'probe.js', `${prelude(lock)}fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ pid: readPid(), held: process.env.${HELD} }));`);
  const res = forge(dir, ['lease', 'db', '--', process.execPath, probe], { [HELD]: 'other:424242' });
  assert.equal(res.status, 0, res.stderr);
  const p = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(p.held, `other:424242,db:${p.pid}`);
});

test('a stale variable naming a dead pid does not bypass a real holder', async () => {
  const { dir } = makeProject();
  const marker = path.join(dir, 'ran');
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const { child, held } = holdFromChild(dir);
  await held;
  try {
    const res = forge(
      dir,
      ['lease', 'db', '--wait-ms', '500', '--', process.execPath, '-e', `require('fs').writeFileSync(process.env.MARKER,'ran')`],
      { [HELD]: `db:${dead}`, MARKER: marker },
    );
    assert.equal(res.status, 75, res.stderr);
    assert.equal(fs.existsSync(marker), false, 'the command ran although a real holder has db');
  } finally {
    child.kill();
  }
});

test('a variable naming a live pid that does not hold the lock falls back to normal acquisition', async () => {
  const { dir, lock } = makeProject();
  const out = path.join(dir, 'probe.json');
  const probe = script(dir, 'probe.js', `${prelude(lock)}fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ pid: readPid() }));`);

  // Free lease: it is really taken (named by the CLI process, not the listed pid), then released.
  const free = forge(dir, ['lease', 'db', '--', process.execPath, probe], { [HELD]: `db:${process.pid}` });
  assert.equal(free.status, 0, free.stderr);
  const taken = JSON.parse(fs.readFileSync(out, 'utf8')).pid;
  assert.equal(typeof taken, 'number', 'the lease was not taken');
  assert.notEqual(taken, process.pid);
  assert.equal(fs.existsSync(lock), false);

  // Real holder A: the live-but-wrong pid must not skip the wait.
  const marker = path.join(dir, 'ran');
  const { child, held } = holdFromChild(dir);
  await held;
  try {
    const busy = forge(
      dir,
      ['lease', 'db', '--wait-ms', '500', '--', process.execPath, '-e', `require('fs').writeFileSync(process.env.MARKER,'ran')`],
      { [HELD]: `db:${process.pid}`, MARKER: marker },
    );
    assert.equal(busy.status, 75, busy.stderr);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    child.kill();
  }
});

test('forge evidence run inside forge lease db takes the matching db lease re-entrantly and stamps', () => {
  const { dir, lock, ledger } = makeProject();
  const marker = path.join(dir, 'ran');
  const out = path.join(dir, 'outer.json');
  const outer = script(
    dir,
    'outer.js',
    `${prelude(lock)}const before = readPid(); const t0 = Date.now();
const r = spawnSync(process.execPath, [${JSON.stringify(BIN)}, 'evidence', '--tier3', '--scope', 'group', '--', process.execPath, '-e', ${JSON.stringify(`/*db-guarded*/ require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`)}], { stdio: 'inherit', env: process.env });
fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ before, after: readPid(), status: r.status, elapsed: Date.now() - t0 }));`,
  );
  // db's configured waitMs is 3000: an evidence run that waited on its own parent would exit 75.
  const res = forge(dir, ['lease', 'db', '--', process.execPath, outer], { [HELD]: '' });
  assert.equal(res.status, 0, res.stderr);
  const o = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(o.status, 0, 'forge evidence failed inside forge lease db (it waited on its own parent?)');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ran');
  const stamp = JSON.parse(fs.readFileSync(ledger, 'utf8').trim());
  assert.equal(stamp.scope, 'group');
  assert.equal(stamp.ok, true);
  assert.equal(o.after, o.before, 'evidence must not release the outer lease');
  assert.equal(typeof o.before, 'number');
  assert.equal(fs.existsSync(lock), false, 'released when the outer exits');
});

/**
 * `forge evidence <evidenceArgs> -- node db-guarded-outer.js` where the script wraps its work in
 * `forge lease db --wait-ms 2000 -- node probe.js`; the probe records what it sees.
 */
function evidenceThenInnerLease(evidenceArgs) {
  const { dir, lock } = makeProject();
  const probeOut = path.join(dir, 'probe.json');
  const outerOut = path.join(dir, 'outer.json');
  const tier3Lock = leasePathFor(dir, 'tier3');
  const probe = script(
    dir,
    'probe.js',
    `${prelude(lock)}fs.writeFileSync(${JSON.stringify(probeOut)}, JSON.stringify({ pid: readPid(), held: process.env.${HELD} }));`,
  );
  // The file name carries the token the fixture's `db` pattern matches, so evidence takes `db` for it.
  const outer = script(
    dir,
    'db-guarded-outer.js',
    `${prelude(lock)}const t0 = Date.now();
const r = spawnSync(process.execPath, [${JSON.stringify(BIN)}, 'lease', 'db', '--wait-ms', '2000', '--', process.execPath, ${JSON.stringify(probe)}], { stdio: 'inherit', env: process.env });
fs.writeFileSync(${JSON.stringify(outerOut)}, JSON.stringify({ evidencePid: readPid(), status: r.status, elapsed: Date.now() - t0 }));`,
  );
  const res = forge(dir, ['evidence', ...evidenceArgs, '--', process.execPath, outer]);
  return { dir, lock, tier3Lock, res, read: (f) => JSON.parse(fs.readFileSync(f, 'utf8')), probeOut, outerOut };
}

test('forge evidence exports the leases it holds: a script it runs that wraps itself in forge lease db does not wait on evidence', () => {
  const t = evidenceThenInnerLease(['--tier3', '--scope', 'group']);
  assert.equal(t.res.status, 0, t.res.stderr + t.res.stdout);
  const o = t.read(t.outerOut);
  assert.equal(o.status, 0, 'the inner forge lease db waited on evidence, which holds db for the same command');
  const p = t.read(t.probeOut);
  // Exit 0 already proves it did not wait out its 2000 ms wait (that would be 75); wall time is load-dependent.
  assert.equal(typeof o.evidencePid, 'number', 'evidence holds db while the command runs');
  assert.equal(p.pid, o.evidencePid, 'the inner call must leave db.lock naming evidence');
  assert.equal(p.held, `db:${o.evidencePid}`, 'a group-scope run holds db only');
  assert.equal(fs.existsSync(t.lock), false, 'released when evidence exits');
});

test('a full-scope evidence run lists tier3 as well, and the task-evidence path exports its leases too', () => {
  const full = evidenceThenInnerLease(['--tier3', '--scope', 'full']);
  assert.equal(full.res.status, 0, full.res.stderr + full.res.stdout);
  const fo = full.read(full.outerOut);
  assert.equal(fo.status, 0);
  assert.equal(full.read(full.probeOut).held, `tier3:${fo.evidencePid},db:${fo.evidencePid}`);

  const task = evidenceThenInnerLease(['--task', '01-reentrant']);
  assert.equal(task.res.status, 0, task.res.stderr + task.res.stdout);
  const to = task.read(task.outerOut);
  assert.equal(to.status, 0, 'task-evidence path: the inner forge lease db waited on evidence');
  assert.equal(task.read(task.probeOut).held, `db:${to.evidencePid}`);
});

test('a full-scope evidence run nested inside another lease is refused with exit 2; a group-scope one still runs', () => {
  const { dir, tier3Lock } = (() => {
    const p = makeProject();
    return { ...p, tier3Lock: leasePathFor(p.dir, 'tier3') };
  })();
  const marker = path.join(dir, 'ran');
  const cmd = [process.execPath, '-e', `require('fs').writeFileSync(process.env.MARKER,'ran')`];

  const full = forge(dir, ['lease', 'tests', '--', process.execPath, BIN, 'evidence', '--tier3', '--', ...cmd], { MARKER: marker });
  assert.equal(full.status, 2, full.stderr + full.stdout);
  assert.match(full.stderr, /tests/, 'the refusal names the lease the caller holds');
  assert.match(full.stderr, /forge evidence --tier3/, 'and tells the operator to run it directly');
  assert.equal(fs.existsSync(marker), false, 'the command must not run');
  assert.equal(fs.existsSync(tier3Lock), false, 'tier3 must not be left taken');
  assert.equal(fs.existsSync(path.join(dir, '.forge', 'sessions', SESSION, 'verify-runs.jsonl')), false, 'nothing stamped');

  const group = forge(dir, ['lease', 'tests', '--', process.execPath, BIN, 'evidence', '--tier3', '--scope', 'group', '--', ...cmd], { MARKER: marker });
  assert.equal(group.status, 0, group.stderr + group.stdout);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ran');
});
