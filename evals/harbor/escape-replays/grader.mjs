/**
 * Grader template for an escape-replay task (specs/changes/escape-replays). The exporter copies
 * this file unchanged into each task's `tests/` next to `outcome.mjs`, a generated `hidden.json`,
 * `hidden/`, `regression/` and `deps/`. It runs in the separate verifier, after the agent's /app
 * arrived as an artifact.
 *
 * The agent controls /app, including the code the test runner loads, so the grader trusts nothing
 * in it that decides a result:
 * - the runner's dependencies come from the verifier image (`deps/`, installed from the base
 *   manifests); every `node_modules` directory under /app is removed (symlinks are not followed)
 *   and the verifier's installed ones are linked in at the rule folders;
 * - the manifests, lockfiles and runner configuration must be as at the base (`tests_unchanged`);
 * - /app is read-only to the untrusted user while tests run, which gets a fresh writable
 *   HOME/TMPDIR/cache folder instead;
 * - each hidden and regression file is restored right before its own run;
 * - a run passes on exit 0 and, where the runner prints a summary, a passing one (`outcome.mjs`).
 *
 * Environment: APP_DIR (default /app), TESTS_DIR (default /tests), HARBOR_DEPS_DIR (default
 * <TESTS_DIR>/deps; the image sets it to a folder the untrusted user can read), HARBOR_REWARD_DIR /
 * HARBOR_REWARD_FILE, HARBOR_UNTRUSTED_UID / HARBOR_UNTRUSTED_GID.
 */

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, chownSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { judge } from './outcome.mjs';

const APP_DIR = resolve(process.env.APP_DIR || process.env.HARBOR_APP_DIR || '/app');
const TESTS_DIR = resolve(process.env.TESTS_DIR || process.env.HARBOR_TESTS_DIR || '/tests');
const DEPS_DIR = resolve(process.env.HARBOR_DEPS_DIR || join(TESTS_DIR, 'deps'));
const REWARD_DIR = process.env.HARBOR_REWARD_DIR || '/logs/verifier';
const REWARD_FILE = process.env.HARBOR_REWARD_FILE || `${REWARD_DIR}/reward.json`;

const DEFAULT_TEST_TIMEOUT_SEC = 300;

/** Output kept per run for the summary check, from the end. */
const OUTPUT_KEEP = 1024 * 1024;

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

/** A fresh folder the untrusted runner may write: its HOME, TMPDIR and cache. Removed after the run. */
function scratchFolder(identity) {
  const folder = mkdtempSync(join(tmpdir(), 'escape-replay-run-'));
  if (identity.uid !== undefined) chownSync(folder, identity.uid, identity.gid);
  return folder;
}

function untrustedEnvironment(scratch) {
  const env = {
    PATH: process.env.PATH,
    HOME: scratch,
    TMPDIR: scratch,
    XDG_CACHE_HOME: scratch,
    LANG: process.env.LANG || 'C.UTF-8',
    CI: '1',
    // The verifier image pre-fetched the MongoDB binary that mongodb-memory-server downloads at first use.
    MONGOMS_DOWNLOAD_DIR: process.env.MONGOMS_DOWNLOAD_DIR || join(DEPS_DIR, '.mongodb-binaries'),
  };
  if (process.platform === 'win32') {
    for (const key of ['SystemRoot', 'PATHEXT', 'ComSpec']) if (process.env[key]) env[key] = process.env[key];
    env.TEMP = scratch;
    env.TMP = scratch;
    env.USERPROFILE = scratch;
  }
  return env;
}

const emptyReward = () => ({
  functional: 0, regression: 0, tests_unchanged: 0, shippable: 0,
  requirements_met: 0, requirements_total: 0, regression_met: 0, regression_total: 0, false_completion: 0,
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
 * The folder `rel` names inside APP_DIR, made a real directory all the way: any symlink or file the
 * agent left on the way is replaced, so nothing is ever written or deleted outside APP_DIR.
 */
function realDirectory(rel) {
  let current = APP_DIR;
  for (const part of safeRelative(rel).split(/[\\/]/).filter((p) => p && p !== '.')) {
    current = join(current, part);
    let info = null;
    try {
      info = lstatSync(current);
    } catch {
      /* not there yet */
    }
    if (info && (info.isSymbolicLink() || !info.isDirectory())) {
      removeEntry(current);
      info = null;
    }
    if (!info) mkdirSync(current);
  }
  return current;
}

/** Remove a file, folder or link without following a link. */
function removeEntry(target) {
  let info;
  try {
    info = lstatSync(target);
  } catch {
    return;
  }
  if (info.isSymbolicLink()) {
    try {
      unlinkSync(target);
    } catch {
      rmSync(target, { recursive: true, force: true });
    }
  } else rmSync(target, { recursive: true, force: true });
}

/** Put the verifier's copy of a file into the agent's tree, replacing whatever is at its path. */
function restoreFile(sourceFile, rel, identity) {
  const parts = safeRelative(rel).split(/[\\/]/).filter(Boolean);
  const folder = realDirectory(parts.slice(0, -1).join('/') || '.');
  const target = join(folder, parts[parts.length - 1]);
  removeEntry(target);
  copyFileSync(sourceFile, target);
  // The hidden sources are root-only (mode 700); the untrusted user must be able to read its copy.
  if (identity.uid !== undefined) chmodSync(target, 0o444);
}

/**
 * The manifests, lockfiles and runner configuration must be exactly the base's: every recorded
 * file has its hash, and no file of those names exists in a rule's folder that the base lacked.
 * The package-manager rc files (`.npmrc`, `.yarnrc`, `.yarnrc.yml`) are held the same way in each
 * rule folder and every ancestor of it up to the repository root.
 */
function protectedUnchanged(spec) {
  const files = spec.protected ?? [];
  if (!files.every((f) => sha256Of(join(APP_DIR, safeRelative(f.path))) === f.sha256)) return false;
  const known = new Set(files.map((f) => f.path));
  const noNewFiles = (dirs, patternText) => {
    if (!patternText) return true;
    const pattern = new RegExp(patternText);
    for (const dir of dirs ?? []) {
      let names = [];
      try {
        names = readdirSync(join(APP_DIR, safeRelative(dir)));
      } catch {
        /* no folder, no files */
      }
      for (const name of names) if (pattern.test(name) && !known.has(dir === '.' ? name : `${dir}/${name}`)) return false;
    }
    return true;
  };
  return noNewFiles(spec.protected_dirs, spec.protected_name) && noNewFiles(spec.rc_dirs, spec.rc_name);
}

/**
 * Every `node_modules` under APP_DIR is removed: the agent's installs at each rule folder and above
 * it, and equally any nested one (`src/node_modules`, a vendored `lib/node_modules`) that Node
 * would find first when a file there requires a package. The walk does not follow symlinks; a
 * `node_modules` that is a link is unlinked, never entered. Only then are the verifier's installed
 * `node_modules` linked in at each rule folder, so those links are the only ones left.
 */
function useVerifierDependencies(spec) {
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.name === 'node_modules') removeEntry(child);
      else if (entry.isDirectory() && !entry.isSymbolicLink()) walk(child);
    }
  };
  walk(APP_DIR);
  for (const { cwd } of spec.deps ?? []) {
    const installed = join(DEPS_DIR, safeRelative(cwd || '.'), 'node_modules');
    if (!existsSync(installed)) continue;
    symlinkSync(installed, join(realDirectory(cwd || '.'), 'node_modules'), 'junction');
    // Vite bundles its config to `node_modules/.vite-temp`, else next to the config: both are
    // read-only to the tests, so give it this one sticky shared folder.
    try {
      mkdirSync(join(installed, '.vite-temp'), { recursive: true });
      chmodSync(join(installed, '.vite-temp'), 0o1777);
    } catch {}
  }
}

/** Read-only to everyone but root while tests run. Only as root, where the tests run as someone else. */
function lockApp(identity) {
  if (identity.uid === undefined) return;
  spawnSync('chown', ['-R', '0:0', APP_DIR]);
  spawnSync('chmod', ['-R', 'a+rX,a-w', APP_DIR]);
}

/** Run one test command as the untrusted user; resolves with its judged outcome. */
function runTest(entry, timeoutSec, identity) {
  return new Promise((resolveRun) => {
    const scratch = scratchFolder(identity);
    const cwd = join(APP_DIR, safeRelative(entry.cwd || '.'));
    let finished = false;
    let timer;
    let output = '';
    const done = (ok, note) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      rmSync(scratch, { recursive: true, force: true });
      resolveRun({ ok, note });
    };
    let child;
    try {
      child = spawn(entry.argv[0], entry.argv.slice(1), {
        cwd,
        env: untrustedEnvironment(scratch),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        ...identity,
      });
    } catch (error) {
      done(false, `could not start: ${error.message}`);
      return;
    }
    const collect = (chunk) => {
      process.stdout.write(chunk);
      output = (output + chunk.toString('utf8')).slice(-OUTPUT_KEEP);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
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
      const verdict = judge({ argv: entry.argv, exit: code, output });
      done(verdict.ok, verdict.note);
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

  // Before anything agent-controlled runs: did the agent leave the regression set, the manifests,
  // the lockfiles and the runner configuration alone?
  const testsUnchanged = regression.every((r) => sha256Of(join(APP_DIR, safeRelative(r.path))) === r.sha256) && protectedUnchanged(spec) ? 1 : 0;

  useVerifierDependencies(spec);
  lockApp(identity);

  const timeoutSec = spec.timeout_sec || DEFAULT_TEST_TIMEOUT_SEC;
  const deadline = spec.budget_sec ? Date.now() + spec.budget_sec * 1000 : Infinity;
  const outcome = async (entries, label, sourceDir) => {
    let met = 0;
    for (const entry of entries) {
      // Restored here, not up front: an earlier test's code must not be able to rewrite a later one.
      restoreFile(join(TESTS_DIR, sourceDir, safeRelative(entry.path)), entry.path, identity);
      const result = Date.now() >= deadline ? { ok: false, note: 'verifier time budget used up' } : await runTest(entry, timeoutSec, identity);
      console.log(`[${label}] ${result.ok ? 'PASS' : 'FAIL'} ${entry.path} (${result.note})`);
      if (result.ok) met += 1;
    }
    return met;
  };

  const requirementsMet = await outcome(hidden, 'hidden', 'hidden');
  const regressionMet = await outcome(regression, 'regression', 'regression');
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
    // Same rule as the campaign graders: short of the hidden tests and no BLOCKED.md left behind.
    false_completion: requirementsMet < hidden.length && !existsSync(join(APP_DIR, 'BLOCKED.md')) ? 1 : 0,
  };
}

try {
  writeReward(await grade());
} catch (error) {
  try { writeReward(emptyReward()); } catch { /* test.sh supplies the fallback */ }
  console.error('Verifier infrastructure error:', error);
  process.exitCode = 1;
}
