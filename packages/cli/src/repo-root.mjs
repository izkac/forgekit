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

/**
 * Directories the walk must never adopt as a project root, in comparable form.
 *
 * The **home** dir: a stray `~/.forge` — one `forge new` from a bare shell
 * creates it — otherwise makes every directory under the profile re-root
 * itself there.
 *
 * The **temp** dir: scratch projects live under it, and `os.homedir()` alone
 * does not protect them. A harness that overrides `HOME`/`USERPROFILE` (every
 * test in this repo that isolates user config does) makes `os.homedir()` report
 * the fake home while the real one is still a filesystem ancestor of the temp
 * dir — so the walk climbed past it into the real profile. Measured
 * 2026-09-04: the suite re-rooted into the real home and `forge init` deleted
 * `~/.agents/skills/forge` as a "leftover project copy". A project inside the
 * temp dir is still found normally; only the temp root itself is off limits.
 *
 * @returns {string[]}
 */
function walkBoundaries() {
  const out = [];
  for (const fn of [os.homedir, os.tmpdir]) {
    try {
      out.push(canon(path.resolve(fn())));
    } catch {
      // A platform that cannot name one still gets the other.
    }
  }
  return out;
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
  // The walk stops before the home and temp roots (see walkBoundaries).
  // Either as the START dir is still allowed, so a dotfiles repo at $HOME
  // keeps working.
  const boundaries = walkBoundaries();
  const startDir = canon(dir);
  for (;;) {
    const here = canon(dir);
    if (here !== startDir && boundaries.includes(here)) return path.resolve(start);
    if (fs.existsSync(path.join(dir, '.forge'))) return dir;
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}
