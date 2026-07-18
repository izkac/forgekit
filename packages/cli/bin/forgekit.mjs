#!/usr/bin/env node
/**
 * Forgekit meta CLI — install / list skills across agent environments.
 *
 * Skill day-to-day commands stay on `forge` and `review`.
 *
 * Usage: forgekit <command> [args...]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src');

/** @type {Record<string, { script: string, prependArgs?: string[] }>} */
const COMMANDS = {
  install: { script: 'install.mjs' },
  list: { script: 'install.mjs', prependArgs: ['--list'] },
};

function printHelp() {
  process.stdout.write(`Forgekit — portable agent skills

Usage:
  forgekit <command> [args...]

Commands:
  install                 Install skills into ~/.cursor|claude|codex/skills/
  list                    Show installed vs missing (skill × agent)

Install picks skills and agents (interactive on TTY, or via flags):

  forgekit install
  forgekit install --skills forge,thorough-code-review --agents cursor,claude
  forgekit install --all-skills --all-agents --force
  forgekit list

Day-to-day skill CLIs (same package):

  forge …                 Forge workflow sessions
  review …                Thorough code review pipeline

  forge install …         Alias → forgekit install --skills forge …
  review install …        Alias → forgekit install --skills thorough-code-review …
`);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
  printHelp();
  process.exit(0);
}

const [cmd, ...rest] = argv;
const entry = COMMANDS[cmd];

if (!entry) {
  process.stderr.write(`Unknown command: ${cmd}\n\n`);
  printHelp();
  process.exit(1);
}

const args = [...(entry.prependArgs ?? []), ...rest];
const r = spawnSync(process.execPath, [path.join(SRC, entry.script), ...args], {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: {
    ...process.env,
    FORGEKIT_ROOT: path.resolve(__dirname, '..', '..', '..'),
    FORGEKIT_CLI_ROOT: path.resolve(__dirname, '..'),
  },
});

process.exit(r.status ?? 1);
