#!/usr/bin/env node
/**
 * Review CLI — thorough-code-review scaffolding, render, export, signals.
 *
 * Usage: review <command> [args...]
 * Install: review install → forgekit install --skills thorough-code-review …
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src');
const REVIEW_SRC = path.join(SRC, 'review');

/** @type {Record<string, { script: string, prependArgs?: string[] }>} */
const COMMANDS = {
  new: { script: path.join(REVIEW_SRC, 'new-review.mjs') },
  render: { script: path.join(REVIEW_SRC, 'render.mjs') },
  export: { script: path.join(REVIEW_SRC, 'export.mjs') },
  carryforward: { script: path.join(REVIEW_SRC, 'carryforward.mjs') },
  merge: { script: path.join(REVIEW_SRC, 'merge-tentative.mjs') },
  signals: { script: path.join(REVIEW_SRC, 'signals.mjs') },
  install: {
    script: path.join(SRC, 'install.mjs'),
    prependArgs: ['--skills', 'thorough-code-review'],
  },
};

function printHelp() {
  process.stdout.write(`Review — thorough code review tooling

Usage:
  review <command> [args...]

Commands:
  new <slug>              Scaffold .reviews/<id>-review.json
  render                  Generate markdown from JSON
  export                  Validate + summarize (+ optional CI gate)
  carryforward            Inherit prior verdicts for unchanged files
  merge                   Merge scout tentative JSON shards
  signals                 Plan typecheck/lint/test grounding commands
  install                 Alias → forgekit install --skills thorough-code-review

Prefer \`forgekit install\` to pick multiple skills + agents at once.

Global:
  review --help
  review <command> --help

After install, invoke the skill explicitly in your agent (it does not auto-load).
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
const r = spawnSync(process.execPath, [entry.script, ...args], {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: {
    ...process.env,
    FORGEKIT_ROOT: path.resolve(__dirname, '..', '..', '..'),
    FORGEKIT_CLI_ROOT: path.resolve(__dirname, '..'),
  },
});

process.exit(r.status ?? 1);
