#!/usr/bin/env node
/**
 * Project-root resolution.
 *
 * Standalone (node builtins only) so the `forge` bin can re-root itself
 * without importing session machinery.
 */

import fs from 'node:fs';
import path from 'node:path';

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
  for (;;) {
    if (fs.existsSync(path.join(dir, '.forge'))) return dir;
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}
