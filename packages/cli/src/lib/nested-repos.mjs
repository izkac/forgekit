/**
 * Nested git repositories under a project root (volo keeps its code in
 * `volo_web`, `volo_mobile`): the HEADs `forge new` records, and the ranges
 * `forge phase done` derives from them. Shared so discovery has one rule.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * HEAD of every git repo nested at most two directories below `root` (a dir
 * holding a `.git` entry — directory or worktree/submodule file), keyed by
 * posix relative path. `node_modules` and dot-dirs are not scanned; a found
 * repo is not descended into; a repo whose HEAD can't be read is omitted.
 *
 * @param {string} root
 * @returns {Record<string, string>}
 */
export function nestedBaseCommits(root) {
  /** @type {Record<string, string>} */
  const found = {};
  const scan = (/** @type {string} */ abs, /** @type {string} */ rel, /** @type {number} */ depth) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // unreadable directory — never break `forge new`
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (fs.existsSync(path.join(childAbs, '.git'))) {
        const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: childAbs, encoding: 'utf8' });
        if (r.status === 0 && r.stdout.trim()) found[childRel] = r.stdout.trim();
      } else if (depth < 2) {
        scan(childAbs, childRel, depth + 1);
      }
    }
  };
  scan(root, '', 1);
  return found;
}

/**
 * The Commit range of each recorded nested repo whose HEAD moved since `forge
 * new`. A repo whose directory or HEAD is gone is skipped with one stderr
 * note; one that did not move is omitted.
 *
 * @param {string} root
 * @param {Record<string, string>} bases `session.nestedBaseCommits`
 * @returns {Record<string, { base: string, head: string }>}
 */
export function nestedCommitRanges(root, bases) {
  /** @type {Record<string, { base: string, head: string }>} */
  const ranges = {};
  for (const [repo, base] of Object.entries(bases)) {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(root, repo), encoding: 'utf8' });
    const head = r.status === 0 ? r.stdout.trim() : '';
    if (!head) {
      process.stderr.write(`[forge] Note: nested repo "${repo}" is gone or has no HEAD; no commit range recorded for it.\n`);
    } else if (head !== base) {
      ranges[repo] = { base, head };
    }
  }
  return ranges;
}
