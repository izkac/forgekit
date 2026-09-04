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
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/**
 * Delete anything in `dest` with no counterpart in `src`.
 *
 * `tryEmptyDir` is best-effort — on Windows it hits EPERM and falls back to
 * "overwrite in place", which copies new files over old ones but never removes
 * a file that was DELETED from source. Measured 2026-09-04: a reference doc
 * removed from the thorough-code-review skill shipped in 0.3.57 anyway, one
 * version after it stopped existing, because nothing ever pruned it. Copying is
 * not mirroring; this is the half that makes it one.
 *
 * A delete that fails is reported, never thrown: the caller decides whether a
 * stale file it cannot remove should block the publish, and a raw EPERM here
 * would bury that decision under a stack trace.
 *
 * @param {string} src
 * @param {string} dest
 * @returns {{ removed: string[], failed: string[] }} paths relative to dest
 */
export function pruneExtraneous(src, dest) {
  /** @type {{ removed: string[], failed: string[] }} */
  const out = { removed: [], failed: [] };
  if (!fs.existsSync(dest)) return out;

  for (const entry of fs.readdirSync(dest, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (!fs.existsSync(from)) {
      try {
        fs.rmSync(to, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        out.removed.push(entry.name);
      } catch {
        out.failed.push(entry.name);
      }
      continue;
    }
    if (entry.isDirectory()) {
      const nested = pruneExtraneous(from, to);
      out.removed.push(...nested.removed.map((p) => path.join(entry.name, p)));
      out.failed.push(...nested.failed.map((p) => path.join(entry.name, p)));
    }
  }
  return out;
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

  const trees = [
    [skillsSrc, 'skills'],
    [templatesSrc, 'templates'],
  ];
  // Fail rather than publish a tree that does not match source: a stale file
  // surviving both the empty and the prune is a packaging bug, and the tarball
  // is the last place to find out.
  for (const [src, name] of trees) {
    const { removed, failed } = pruneExtraneous(src, path.join(vendorRoot, name));
    for (const rel of removed) {
      process.stdout.write(`prepack: pruned stale ${name}/${rel.split(path.sep).join('/')}\n`);
    }
    const leftovers = failed.map((rel) => rel.split(path.sep).join('/'));
    if (leftovers.length > 0) {
      throw new Error(
        `prepack: vendor/${name} still holds files absent from source: ${leftovers.join(', ')}\n` +
          `  These would ship in the tarball. They could not be deleted — on Windows this is\n` +
          `  usually a vendor/ tree created by a different (elevated) account, so the current\n` +
          `  user inherits write but not delete. vendor/ is gitignored and fully regenerated\n` +
          `  here, so clearing it is safe:\n` +
          `    Remove-Item -Recurse -Force ${vendorRoot}      (elevated shell)\n` +
          `  then re-run the publish.`,
      );
    }
  }
  process.stdout.write(`prepack: vendored skills + templates → ${vendorRoot}\n`);
}

// Guarded so the pruning logic can be imported by a test without vendoring
// the whole monorepo as a side effect.
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main();
}
