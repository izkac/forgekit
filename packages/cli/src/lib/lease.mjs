/**
 * Named, exclusive, cross-worktree leases.
 *
 * A lease serializes a scarce resource (the full tier-3 suite, a database, a
 * port) across every session and worktree of one repository. It lives under the
 * git common dir (`<common>/forge/leases/<name>.lock`) so all worktrees share
 * it, and at `<project>/.forge/leases/<name>.lock` outside git. `forge evidence
 * --tier3` (scope full) holds the built-in `tier3` lease through this module.
 *
 * Names match `^[a-z0-9][a-z0-9-]*$`; internal names are `_` + that pattern.
 *
 * A lease saves time and guards nothing: any failure to create it proceeds
 * unlocked with a warning.
 *
 * ponytail: two waiters racing on the same dead holder can both take over and
 * both run once. Perf only, never correctness. Upgrade: rename-and-verify
 * ownership of the renamed file before unlinking it.
 * Second ceiling: a crashed holder whose pid is reused by an unrelated live
 * process looks alive, so waiters wait without a timeout unless the caller
 * passes `waitMs`. The "held by …" notice repeats every 60 s naming the pid and
 * the lease path's holder; delete the lease file by hand. Upgrade: compare the
 * holder's process start time.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** An unparseable lock older than this is stale; a fresh one may be a live holder mid-write. */
const STALE_UNPARSEABLE_MS = 30_000;
/** How often the "waiting" notice repeats while the holder keeps the lock. */
const NOTICE_EVERY_MS = 60_000;
const DEFAULT_POLL_MS = 5000;

const PUBLIC_NAME = /^[a-z0-9][a-z0-9-]*$/;
const INTERNAL_NAME = /^_[a-z0-9][a-z0-9-]*$/;

/**
 * @param {unknown} name
 * @param {{ internal?: boolean }} [opts] internal → the `_`-prefixed form; otherwise the public form
 * @returns {boolean}
 */
export function isValidLeaseName(name, { internal = false } = {}) {
  return typeof name === 'string' && (internal ? INTERNAL_NAME : PUBLIC_NAME).test(name);
}

/** @param {unknown} name @param {boolean} internal */
function assertValidName(name, internal) {
  if (!isValidLeaseName(name, { internal })) {
    throw new Error(
      `Invalid lease name ${JSON.stringify(name)}: use lowercase letters, digits and "-" (${internal ? '"_" + name for internal leases' : 'must start with a letter or digit'})`,
    );
  }
}

/** Thrown by `acquireLease` when `waitMs` passes while a live process keeps the lease. */
export class LeaseBusyError extends Error {
  /**
   * @param {string} lease
   * @param {{ pid?: number, sessionId?: string | null, slug?: string | null, startedAt?: string } | null} holder
   */
  constructor(lease, holder) {
    const who = holder?.slug || holder?.sessionId || 'unknown';
    super(`lease ${lease} is busy: held by ${who} (pid ${holder?.pid ?? 'unknown'}, since ${holder?.startedAt ?? 'unknown'})`);
    this.name = 'LeaseBusyError';
    this.lease = lease;
    this.holder = holder;
  }
}

/**
 * @param {string} cwd
 * @returns {string}
 */
function leasesDirFor(cwd) {
  const res = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8' });
  const out = res.status === 0 && typeof res.stdout === 'string' ? res.stdout.trim() : '';
  // git may print a path relative to cwd (`.git`), so resolve it against cwd.
  if (out) return path.join(path.resolve(cwd, out), 'forge', 'leases');
  return path.join(cwd, '.forge', 'leases');
}

/**
 * @param {string} cwd
 * @param {string} name
 * @param {{ internal?: boolean }} [opts]
 * @returns {string}
 */
export function leasePathFor(cwd, name, { internal = false } = {}) {
  assertValidName(name, internal);
  return path.join(leasesDirFor(cwd), `${name}.lock`);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // Our own pid in a lock we are still acquiring is a leftover, not a holder.
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code !== 'ESRCH';
  }
}

/** @returns {{ pid?: number, sessionId?: string | null, slug?: string | null, startedAt?: string } | null} */
function readHolder(lock) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lock, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function takeOver(lock) {
  const aside = `${lock}.stale.${process.pid}`;
  try {
    fs.renameSync(lock, aside);
    fs.unlinkSync(aside);
  } catch {
    // Someone else took it over first; the retry decides.
  }
}

/**
 * Take the named lease, waiting while a live process holds it.
 *
 * @param {{ cwd: string, name: string, internal?: boolean, sessionId?: string | null, slug?: string | null, waitMs?: number, pollMs?: number, notify?: (message: string) => void }} args
 *   `waitMs` (default unbounded) caps the wait for a live holder; past it a `LeaseBusyError` is thrown.
 * @returns {() => void} release — removes the lease file only if it still names this process; idempotent
 */
export function acquireLease({
  cwd,
  name,
  internal = false,
  sessionId = null,
  slug = null,
  waitMs = Infinity,
  pollMs = DEFAULT_POLL_MS,
  notify = (m) => process.stderr.write(`${m}\n`),
}) {
  const lock = leasePathFor(cwd, name, { internal });
  const noop = () => {};
  const waitStart = Date.now();
  let lastNotice = -Infinity;
  // Windows refuses `wx` with EPERM/EACCES while a released lock's delete is
  // still pending. ponytail: a few short retries before failing open; a real
  // permission problem still fails open, just ~0.5 s later.
  let busyRetries = 5;

  const unlocked = (err) => {
    notify(`[forge] Warning: could not create lease ${name} at ${lock} (${/** @type {Error} */ (err).message}) — running unlocked`);
    return noop;
  };

  for (;;) {
    let fd;
    try {
      fs.mkdirSync(path.dirname(lock), { recursive: true });
    } catch (err) {
      // e.g. a regular file sits where the directory should be.
      return unlocked(err);
    }
    try {
      fd = fs.openSync(lock, 'wx');
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if ((code === 'EPERM' || code === 'EACCES') && busyRetries > 0) {
        busyRetries -= 1;
        sleep(100);
        continue;
      }
      if (code !== 'EEXIST') return unlocked(err);
      // Held (or released a moment ago — readHolder/stat below retry that).
    }
    if (fd !== undefined) {
      try {
        fs.writeSync(fd, JSON.stringify({ name, pid: process.pid, sessionId, slug, cwd, startedAt: new Date().toISOString() }));
      } catch (err) {
        fs.closeSync(fd);
        try {
          fs.unlinkSync(lock);
        } catch {
          // best effort
        }
        notify(`[forge] Warning: could not write lease ${name} at ${lock} (${/** @type {Error} */ (err).message}) — running unlocked`);
        return noop;
      }
      fs.closeSync(fd);
      return makeRelease(lock);
    }

    // The lock exists: stale, or someone is running.
    if (!fs.existsSync(lock)) continue; // released between open and here — take it
    const holder = readHolder(lock);
    if (holder) {
      if (!isAlive(holder.pid)) {
        takeOver(lock);
        continue;
      }
    } else {
      let ageMs = 0;
      try {
        ageMs = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue; // vanished between read and stat — retry
      }
      if (ageMs > STALE_UNPARSEABLE_MS) {
        takeOver(lock);
        continue;
      }
    }

    // An already-expired wait fails before any "waiting" notice.
    const waited = Date.now() - waitStart;
    if (waited >= waitMs) throw new LeaseBusyError(name, holder);
    const now = Date.now();
    if (now - lastNotice >= NOTICE_EVERY_MS) {
      lastNotice = now;
      const who = holder?.slug || holder?.sessionId || 'unknown';
      notify(
        `[forge] lease ${name} held by ${who} (pid ${holder?.pid ?? 'unknown'}, since ${holder?.startedAt ?? 'unknown'}) — waiting; lease file ${lock}`,
      );
    }
    sleep(Math.min(pollMs, waitMs - waited));
  }
}

/** @param {string} lock */
function makeRelease(lock) {
  let released = false;
  // Only an `exit` backstop: the lock is held inside spawnSync, where signal
  // listeners cannot run, and installing them would swallow Ctrl-C after
  // release. A hard kill leaves the file for the dead-pid takeover.
  const onExit = () => release();
  function release() {
    if (released) return;
    released = true;
    process.removeListener('exit', onExit);
    // Never delete a lock that someone else has since taken.
    if (readHolder(lock)?.pid !== process.pid) return;
    try {
      fs.unlinkSync(lock);
    } catch {
      // already gone
    }
  }
  process.once('exit', onExit);
  return release;
}

/**
 * Every lease file under the shared leases dir, sorted by name.
 *
 * @param {string} cwd
 * @returns {{ name: string, path: string, holder: object | null, alive: boolean }[]}
 */
export function listLeases(cwd) {
  const dir = leasesDirFor(cwd);
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith('.lock'))
    .map((f) => {
      const file = path.join(dir, f);
      const holder = readHolder(file);
      return { name: f.slice(0, -'.lock'.length), path: file, holder, alive: holder ? isAlive(holder.pid) : false };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
