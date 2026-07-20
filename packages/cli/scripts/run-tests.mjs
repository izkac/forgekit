#!/usr/bin/env node
/**
 * Run all src test files (*.test.mjs) via node --test.
 *
 * Node 20 does not expand globs passed to `node --test`; Node 22+ does.
 * Explicit file discovery keeps CI green on the engines.node >=20 matrix.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(__dirname, '..');
const srcRoot = path.join(cliRoot, 'src');

/**
 * @param {string} dir
 * @returns {string[]}
 */
function findTestFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findTestFiles(full));
    else if (entry.name.endsWith('.test.mjs')) out.push(full);
  }
  return out;
}

const files = findTestFiles(srcRoot).sort();
if (files.length === 0) {
  console.error(`No *.test.mjs files under ${srcRoot}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: cliRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    // Keep saveSession's fleet-registry mirroring away from ~/.forgekit
    // when tests exercise session saves with scratch projects.
    FORGEKIT_FLEET_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-test-fleet-')),
  },
});
process.exit(result.status ?? 1);
