/**
 * Grader template for an escape-replay task (specs/changes/escape-replays). The exporter copies
 * this file unchanged into each task's `tests/` next to a generated `hidden.json`, `hidden/` and
 * `regression/`. It runs in the separate verifier, after the agent's /app arrived as an artifact.
 *
 * It restores the verifier's own copies of the hidden tests and the regression set over the
 * agent's tree, runs each with its recorded command as the untrusted user, and writes
 * `reward.json`. Environment: APP_DIR (default /app), TESTS_DIR (default /tests),
 * HARBOR_REWARD_DIR / HARBOR_REWARD_FILE, HARBOR_UNTRUSTED_UID / HARBOR_UNTRUSTED_GID.
 */

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const APP_DIR = resolve(process.env.APP_DIR || process.env.HARBOR_APP_DIR || '/app');
const TESTS_DIR = resolve(process.env.TESTS_DIR || process.env.HARBOR_TESTS_DIR || '/tests');
const REWARD_DIR = process.env.HARBOR_REWARD_DIR || '/logs/verifier';
const REWARD_FILE = process.env.HARBOR_REWARD_FILE || `${REWARD_DIR}/reward.json`;

const DEFAULT_TEST_TIMEOUT_SEC = 240;

function configuredIdentity() {
  const uidText = process.env.HARBOR_UNTRUSTED_UID;
  const gidText = process.env.HARBOR_UNTRUSTED_GID;
  if (uidText === undefined && gidText === undefined) return {};
  if (!/^[0-9]+$/.test(uidText || '') || !/^[0-9]+$/.test(gidText || '')) {
    throw new Error('Invalid untrusted uid/gid configuration');
  }
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    throw new Error('The hidden verifier must remain root to drop application privileges');
  }
  return { uid: Number(uidText), gid: Number(gidText) };
}

function untrustedEnvironment() {
  const env = {
    PATH: process.env.PATH,
    HOME: '/tmp',
    LANG: process.env.LANG || 'C.UTF-8',
    CI: '1',
    // The agent image pre-fetched the MongoDB binary that mongodb-memory-server downloads at first use.
    MONGOMS_DOWNLOAD_DIR: process.env.MONGOMS_DOWNLOAD_DIR || join(APP_DIR, '.mongodb-binaries'),
  };
  if (process.platform === 'win32') {
    for (const key of ['SystemRoot', 'TEMP', 'TMP', 'PATHEXT', 'ComSpec']) if (process.env[key]) env[key] = process.env[key];
    env.HOME = process.env.TEMP || process.env.USERPROFILE || env.HOME;
  }
  return env;
}

const emptyReward = () => ({
  functional: 0, regression: 0, tests_unchanged: 0, shippable: 0,
  requirements_met: 0, requirements_total: 0, regression_met: 0, regression_total: 0,
});

function writeReward(reward) {
  mkdirSync(dirname(REWARD_FILE), { recursive: true });
  writeFileSync(REWARD_FILE, `${JSON.stringify(reward)}\n`, 'utf8');
}

/** A path from hidden.json must stay inside the tree it is joined to. */
function safeRelative(rel) {
  if (typeof rel !== 'string' || rel === '' || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split(/[\\/]/).includes('..')) {
    throw new Error(`unsafe path in hidden.json: ${rel}`);
  }
  return rel;
}

function sha256Of(file) {
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Put the verifier's copy of a file into the agent's tree. Any symlink the agent left on the way
 * (a folder or the file itself) is replaced, so nothing is ever written outside APP_DIR.
 */
function restoreFile(sourceFile, rel) {
  const parts = safeRelative(rel).split(/[\\/]/).filter(Boolean);
  let current = APP_DIR;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    let info = null;
    try {
      info = lstatSync(current);
    } catch {
      /* not there yet */
    }
    if (info && (info.isSymbolicLink() || !info.isDirectory())) {
      rmSync(current, { recursive: true, force: true });
      info = null;
    }
    if (!info) mkdirSync(current);
  }
  const target = join(current, parts[parts.length - 1]);
  rmSync(target, { recursive: true, force: true });
  copyFileSync(sourceFile, target);
}

/** Run one test command as the untrusted user; resolves with whether it exited 0 within the timeout. */
function runTest(entry, timeoutSec, identity) {
  return new Promise((resolveRun) => {
    const cwd = join(APP_DIR, safeRelative(entry.cwd || '.'));
    let finished = false;
    let timer;
    const done = (ok, note) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolveRun({ ok, note });
    };
    let child;
    try {
      child = spawn(entry.argv[0], entry.argv.slice(1), {
        cwd,
        env: untrustedEnvironment(),
        stdio: ['ignore', 'inherit', 'inherit'],
        detached: process.platform !== 'win32',
        ...identity,
      });
    } catch (error) {
      done(false, `could not start: ${error.message}`);
      return;
    }
    // A test may leave helper processes (a MongoDB server); take the whole group down with it.
    const killGroup = () => {
      if (child.pid == null) return;
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    };
    child.once('error', (error) => done(false, `could not start: ${error.message}`));
    child.once('close', (code) => {
      killGroup();
      done(code === 0, code === 0 ? 'passed' : `exit ${code}`);
    });
    timer = setTimeout(() => {
      killGroup();
      done(false, `timed out after ${timeoutSec}s`);
    }, timeoutSec * 1000);
  });
}

async function grade() {
  const spec = JSON.parse(readFileSync(join(TESTS_DIR, 'hidden.json'), 'utf8'));
  const hidden = spec.hidden ?? [];
  const regression = spec.regression ?? [];
  const identity = configuredIdentity();
  mkdirSync(REWARD_DIR, { recursive: true });
  try { chmodSync(REWARD_DIR, 0o700); } catch { /* local run */ }

  // Before anything agent-controlled runs: did the agent leave the regression set's files alone?
  const testsUnchanged = regression.every((r) => sha256Of(join(APP_DIR, safeRelative(r.path))) === r.sha256) ? 1 : 0;

  for (const h of hidden) restoreFile(join(TESTS_DIR, 'hidden', safeRelative(h.path)), h.path);
  for (const r of regression) restoreFile(join(TESTS_DIR, 'regression', safeRelative(r.path)), r.path);

  if (identity.uid !== undefined) {
    // The tests run as nobody and need to write caches and lock files; the app is the agent's own tree.
    spawnSync('chmod', ['-R', 'a+rX', APP_DIR]);
    const binaries = join(APP_DIR, '.mongodb-binaries');
    if (existsSync(binaries)) spawnSync('chmod', ['-R', 'a+x', binaries]);
    spawnSync('chown', ['-R', `${identity.uid}:${identity.gid}`, APP_DIR]);
  }

  const timeoutSec = spec.timeout_sec || DEFAULT_TEST_TIMEOUT_SEC;
  const deadline = spec.budget_sec ? Date.now() + spec.budget_sec * 1000 : Infinity;
  const outcome = async (entries, label) => {
    let met = 0;
    for (const entry of entries) {
      const result = Date.now() >= deadline ? { ok: false, note: 'verifier time budget used up' } : await runTest(entry, timeoutSec, identity);
      console.log(`[${label}] ${result.ok ? 'PASS' : 'FAIL'} ${entry.path} (${result.note})`);
      if (result.ok) met += 1;
    }
    return met;
  };

  const requirementsMet = await outcome(hidden, 'hidden');
  const regressionMet = await outcome(regression, 'regression');
  const functional = hidden.length > 0 && requirementsMet === hidden.length ? 1 : 0;
  const regressionOk = regressionMet === regression.length ? 1 : 0;
  return {
    functional,
    regression: regressionOk,
    tests_unchanged: testsUnchanged,
    shippable: functional && regressionOk && testsUnchanged ? 1 : 0,
    requirements_met: requirementsMet,
    requirements_total: hidden.length,
    regression_met: regressionMet,
    regression_total: regression.length,
  };
}

try {
  writeReward(await grade());
} catch (error) {
  try { writeReward(emptyReward()); } catch { /* test.sh supplies the fallback */ }
  console.error('Verifier infrastructure error:', error);
  process.exitCode = 1;
}
