#!/usr/bin/env node
/**
 * Project-root resolution.
 *
 * Standalone (node builtins only) so the `forge` bin can re-root itself
 * without importing session machinery.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Comparable form of a path: real path when it exists, case-folded on win32. */
function canon(p) {
  let real = p;
  try {
    real = fs.realpathSync.native(p);
  } catch {
    // not on disk yet — compare the literal
  }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/** `null` when the platform cannot name a home dir (no HOME/USERPROFILE, no passwd entry). */
function resolvedHome() {
  try {
    return canon(path.resolve(os.homedir()));
  } catch {
    return null;
  }
}

/**
 * Nearest enclosing project root: the closest ancestor holding `.forge/`,
 * else the closest holding `.git/` (a repo boundary — a nested checkout must
 * not adopt the enclosing project's sessions), else the start dir.
 *
 * Without this, forge was bound to the exact cwd: `cd crates && forge status`
 * reported "no session" in a repo that had one, and `forge new` there would
 * have created a second `.forge` tree inside the workspace.
 *
 * @param {string} [start]
 * @returns {string}
 */
export function findRepoRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  // The walk never climbs into the home directory (or above it): a stray
  // `~/.forge` — one `forge new` run from a bare shell is enough to create it
  // — otherwise makes every temp-dir `forge` invocation re-root itself in the
  // home dir. Measured 2026-09-04: `forge init` under the test suite retired
  // `~/.agents/skills/forge` as a "leftover project copy". Home itself as the
  // start dir is still allowed, so a dotfiles repo keeps working.
  const home = resolvedHome();
  const startDir = canon(dir);
  for (;;) {
    if (home !== null && canon(dir) === home && canon(dir) !== startDir) return path.resolve(start);
    if (fs.existsSync(path.join(dir, '.forge'))) return dir;
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}
