#!/usr/bin/env node
/**
 * Resolve forgekit asset roots (skills, templates).
 *
 * Search order for assets:
 *   1. FORGEKIT_ROOT env (dev / linked monorepo)
 *   2. Monorepo root (packages/cli/../../..)
 *   3. Vendored copy inside the published package (packages/cli/vendor)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @returns {string} Absolute path to packages/cli */
export function cliPackageRoot() {
  return path.resolve(__dirname, '..');
}

/**
 * Candidate forgekit roots that may contain skills/ and templates/.
 * @returns {string[]}
 */
export function forgekitRootCandidates() {
  const roots = [];
  if (process.env.FORGEKIT_ROOT) roots.push(process.env.FORGEKIT_ROOT);
  // Monorepo: packages/cli/src → ../../../
  roots.push(path.resolve(__dirname, '..', '..', '..'));
  // Published package: vendor/ next to src/
  roots.push(path.join(cliPackageRoot(), 'vendor'));
  return [...new Set(roots.map((r) => path.resolve(r)))];
}

/**
 * @param {string} relativePath e.g. 'skills/forge' or 'templates/project'
 * @param {{ requireFile?: string }} [opts] file that must exist under the candidate
 * @returns {string}
 */
export function resolveAsset(relativePath, opts = {}) {
  const requireFile = opts.requireFile;
  const tried = [];
  for (const root of forgekitRootCandidates()) {
    const candidate = path.join(root, relativePath);
    tried.push(candidate);
    const check = requireFile ? path.join(candidate, requireFile) : candidate;
    if (fs.existsSync(check)) return candidate;
  }
  throw new Error(
    `Asset not found: ${relativePath}${requireFile ? ` (${requireFile})` : ''}.\nTried:\n  ${tried.join('\n  ')}`,
  );
}

/**
 * @returns {string} package version from packages/cli/package.json
 */
export function packageVersion() {
  const pkgPath = path.join(cliPackageRoot(), 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  return pkg.version ?? '0.0.0';
}

/**
 * Stable content hash of a directory (sorted relative paths + file bytes).
 * @param {string} dir
 * @returns {string} sha256 hex
 */
export function hashDirectory(dir) {
  const hash = createHash('sha256');
  /** @type {string[]} */
  const files = [];
  const walk = (d, prefix = '') => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === '.forgekit.json') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else files.push(rel);
    }
  };
  walk(dir);
  files.sort();
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(dir, ...rel.split('/'))));
    hash.update('\0');
  }
  return hash.digest('hex');
}
