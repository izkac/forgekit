#!/usr/bin/env node
/**
 * `forge slot` — this checkout's worktree slot, and the env derived from it.
 *
 *   forge slot                                         print the slot number (0 = main worktree / not a git repo)
 *   forge slot env [--shell dotenv|bash|powershell]    print the slots.env assignments (default dotenv)
 *
 * Templates come from .forge/config.json → slots.env. Warnings go to stderr.
 * Exit codes: 0 ok; 2 usage error.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatSlotEnv, readSlotEnvConfig, renderSlotEnv, SLOT_SHELLS, slotFor, writeSlotEnvFile } from './lib/slots.mjs';

const EXIT_USAGE = 2;

const USAGE = `Usage:
  forge slot                                       print this checkout's slot number
  forge slot env [--shell dotenv|bash|powershell]  print the slots.env assignments (default dotenv)
`;

/** @param {string} message */
function usageError(message) {
  process.stderr.write(`forge slot: ${message}\n${USAGE}`);
  return EXIT_USAGE;
}

/** @param {string[]} warnings */
function printWarnings(warnings) {
  for (const w of warnings) process.stderr.write(`${w}\n`);
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {number} exit code
 */
export function runSlotCli(args, cwd = process.cwd()) {
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.length === 0) {
    const slot = slotFor(cwd);
    writeSlotEnvFile(cwd, { slot });
    process.stdout.write(`${slot}\n`);
    return 0;
  }
  if (args[0] !== 'env') return usageError(`unexpected argument: ${args[0]}`);

  let shell = 'dotenv';
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === '--shell') {
      shell = args[(i += 1)] ?? '';
      if (!SLOT_SHELLS.includes(shell)) return usageError(`--shell must be one of ${SLOT_SHELLS.join(', ')}, got: ${shell || '(nothing)'}`);
    } else {
      return usageError(`unexpected argument: ${args[i]}`);
    }
  }

  const slot = slotFor(cwd);
  const config = readSlotEnvConfig(cwd);
  const rendered = renderSlotEnv(config.env ?? {}, slot);
  printWarnings([...config.warnings, ...rendered.warnings]);
  writeSlotEnvFile(cwd, { slot, warn: () => {} }); // the warnings above already cover it
  process.stdout.write(formatSlotEnv(rendered.vars, shell));
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) process.exit(runSlotCli(process.argv.slice(2)));
