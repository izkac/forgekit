#!/usr/bin/env node
/**
 * Shared workspace loader for repo-level scripts.
 *
 * Reads the root `package.json` `workspaces` globs, expands any trailing `/*`
 * form, and returns `{ name, dir, scripts }` for every member package.json that
 * declares a `name`. `dir` is repo-relative with forward slashes. Unreadable or
 * name-less member manifests are skipped.
 *
 * Extracted from the duplicate copies that lived in
 * `scripts/review/signals.mjs` and `scripts/code-health/apply-gate.mjs`; both
 * (and `scripts/code-health/detect.mjs`) now import it from here.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} repoRoot
 * @returns {Array<{ name: string, dir: string, scripts: Record<string, string> }>}
 */
export function loadWorkspaces(repoRoot) {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const globs = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : [];
  /** @type {string[]} */
  const dirs = [];

  for (const glob of globs) {
    if (glob.endsWith('/*')) {
      const base = glob.slice(0, -2);
      const baseDir = path.join(repoRoot, base);
      if (!fs.existsSync(baseDir)) continue;
      for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(`${base}/${entry.name}`);
      }
    } else {
      dirs.push(glob);
    }
  }

  const packages = [];
  for (const dir of dirs) {
    const pkgPath = path.join(repoRoot, dir, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.name) {
        packages.push({ name: pkg.name, dir: dir.replace(/\\/g, '/'), scripts: pkg.scripts ?? {} });
      }
    } catch {
      /* skip unreadable package.json */
    }
  }
  return packages;
}
