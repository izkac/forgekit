#!/usr/bin/env node
/**
 * Copy skills/ and templates/ from the monorepo root into packages/cli/vendor/
 * so the published npm package is self-contained.
 *
 * Usage: node packages/cli/scripts/prepack.mjs
 * Triggered by npm prepack in @izkac/forgekit.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(__dirname, '..');
const monoRoot = path.resolve(cliRoot, '..', '..');
const vendorRoot = path.join(cliRoot, 'vendor');

/**
 * @param {string} src
 * @param {string} dest
 */
function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(from, to);
    else fs.copyFileSync(from, to);
  }
}

/**
 * Best-effort clear. On Windows EPERM, leave the tree and overwrite in place.
 * @param {string} dir
 * @returns {boolean} true if cleared
 */
function tryEmptyDir(dir) {
  if (!fs.existsSync(dir)) return true;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      fs.rmSync(path.join(dir, entry.name), {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
    return true;
  } catch (err) {
    process.stderr.write(
      `prepack: could not empty ${dir} (${err.code || err.message}); overwriting in place\n`,
    );
    return false;
  }
}

function main() {
  const skillsSrc = path.join(monoRoot, 'skills');
  const templatesSrc = path.join(monoRoot, 'templates');
  if (!fs.existsSync(skillsSrc) || !fs.existsSync(templatesSrc)) {
    if (fs.existsSync(path.join(vendorRoot, 'skills'))) {
      process.stdout.write(`prepack: vendor already present at ${vendorRoot}\n`);
      return;
    }
    throw new Error(
      `prepack: monorepo skills/templates not found at ${monoRoot} and vendor/ missing`,
    );
  }

  fs.mkdirSync(vendorRoot, { recursive: true });
  tryEmptyDir(vendorRoot);
  copyDirRecursive(skillsSrc, path.join(vendorRoot, 'skills'));
  copyDirRecursive(templatesSrc, path.join(vendorRoot, 'templates'));
  process.stdout.write(`prepack: vendored skills + templates → ${vendorRoot}\n`);
}

main();
