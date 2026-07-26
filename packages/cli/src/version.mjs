/**
 * The running CLI's own version.
 *
 * All three bins (`forge`, `forgekit`, `review`) ship from one package, so the
 * version is read from that package's manifest rather than hardcoded — a
 * hardcoded string is exactly the thing that drifts from the installed copy,
 * and "which copy is installed?" is the whole reason to ask.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Package root: the directory holding package.json, bin/ and src/. */
export const CLI_ROOT = path.resolve(__dirname, '..');

export const VERSION_FLAGS = Object.freeze(['--version', '-v']);

/**
 * @param {string | undefined} arg
 */
export function isVersionFlag(arg) {
  return typeof arg === 'string' && VERSION_FLAGS.includes(arg);
}

/**
 * @param {string} [cliRoot]
 * @returns {string} the version, or `unknown` when the manifest can't be read
 */
export function readVersion(cliRoot = CLI_ROOT) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cliRoot, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * `<bin> <version>` — the bin name included because three commands share one
 * package, and a bare number leaves you guessing which one answered.
 *
 * @param {string} binName
 * @param {string} [cliRoot]
 */
export function versionLine(binName, cliRoot) {
  return `${binName} ${readVersion(cliRoot)}\n`;
}
