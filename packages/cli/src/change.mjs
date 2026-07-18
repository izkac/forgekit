#!/usr/bin/env node
/**
 * Specs-engine change scaffolding.
 *
 * Usage:
 *   forge change new <name> [--cwd <path>] [--force]
 *   forge change archive <name> [--cwd <path>] [--date YYYY-MM-DD]
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_SPECS_DIR,
  resolveProjectPlanEngine,
} from './plan-engine.mjs';

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const opts = {
    help: false,
    force: false,
    cwd: process.cwd(),
    date: /** @type {string | null} */ (null),
    action: /** @type {string | null} */ (null),
    name: /** @type {string | null} */ (null),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--force' || arg === '-f') opts.force = true;
    else if (arg === '--cwd') opts.cwd = argv[++i];
    else if (arg === '--date') opts.date = argv[++i];
    else if (!opts.action && (arg === 'new' || arg === 'archive')) opts.action = arg;
    else if (!opts.name && !arg.startsWith('-')) opts.name = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function printHelp() {
  process.stdout.write(`Usage: forge change <new|archive> <name> [options]

Scaffold or archive a change for the built-in specs planning engine.

Commands:
  new <name>       Create specs/changes/<name>/{proposal.md,tasks.md}
  archive <name>   Move specs/changes/<name> → changes/archive/YYYY-MM-DD-<name>

Options:
  --cwd <path>     Project root (default: cwd)
  --date YYYY-MM-DD  Archive date prefix (default: today UTC)
  --force, -f      Overwrite existing proposal/tasks on new
  --help

Requires \`.forge/config.json\` → plan.engine: specs (or run \`forge init --no-openspec\`).
`);
}

/**
 * @param {string} name
 */
export function assertChangeName(name) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(
      `Change name must be kebab-case (got: ${name}). Example: add-stripe-refunds`,
    );
  }
  return name;
}

const PROPOSAL_TMPL = (title) => `# ${title}

## Why

One or two paragraphs: problem / pressure.

## What Changes

- …

## Impact

Affected code/areas, risks, migration notes.
`;

const TASKS_TMPL = `# Tasks

## 1. First group
- [ ] 1.1 Bite-sized task — exact files, expected tests

## 2. Second group
- [ ] 2.1 …
`;

/**
 * @param {string} cwd
 * @param {string} name
 * @param {{ force?: boolean }} [opts]
 */
export function createSpecsChange(cwd, name, opts = {}) {
  assertChangeName(name);
  const engine = resolveProjectPlanEngine(cwd, { useUserDefault: false });
  if (engine.engine !== 'specs') {
    throw new Error(
      `Project plan engine is "${engine.engine}", not "specs". ` +
        `Use \`openspec-propose\` / \`/opsx:propose\` for OpenSpec projects, ` +
        `or \`forge init --no-openspec\` to switch.`,
    );
  }
  const dir = engine.dir || DEFAULT_SPECS_DIR;
  const changeDir = path.join(cwd, dir, 'changes', name);
  fs.mkdirSync(changeDir, { recursive: true });

  /** @type {{ file: string, status: string }[]} */
  const files = [];
  const write = (rel, body) => {
    const dest = path.join(changeDir, rel);
    if (fs.existsSync(dest) && !opts.force) {
      files.push({ file: `${dir}/changes/${name}/${rel}`, status: 'skipped' });
      return;
    }
    fs.writeFileSync(dest, body, 'utf8');
    files.push({ file: `${dir}/changes/${name}/${rel}`, status: 'written' });
  };

  const title = name
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  write('proposal.md', PROPOSAL_TMPL(title));
  write('tasks.md', TASKS_TMPL);

  return { dir, changeDir, name, files };
}

/**
 * @param {string} cwd
 * @param {string} name
 * @param {{ date?: string | null }} [opts]
 */
export function archiveSpecsChange(cwd, name, opts = {}) {
  assertChangeName(name);
  const engine = resolveProjectPlanEngine(cwd, { useUserDefault: false });
  if (engine.engine !== 'specs') {
    throw new Error(
      `Project plan engine is "${engine.engine}", not "specs". ` +
        `Use \`openspec archive\` / \`/opsx:archive\` for OpenSpec projects.`,
    );
  }
  const dir = engine.dir || DEFAULT_SPECS_DIR;
  const src = path.join(cwd, dir, 'changes', name);
  if (!fs.existsSync(src)) {
    throw new Error(`Change not found: ${dir}/changes/${name}`);
  }
  const date =
    opts.date ||
    new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid --date (want YYYY-MM-DD): ${date}`);
  }
  const archiveParent = path.join(cwd, dir, 'changes', 'archive');
  fs.mkdirSync(archiveParent, { recursive: true });
  const destName = `${date}-${name}`;
  const dest = path.join(archiveParent, destName);
  if (fs.existsSync(dest)) {
    throw new Error(`Archive already exists: ${dir}/changes/archive/${destName}`);
  }
  fs.renameSync(src, dest);
  return {
    dir,
    from: `${dir}/changes/${name}`,
    to: `${dir}/changes/archive/${destName}`,
  };
}

/**
 * @param {string[]} argv
 */
export function runChange(argv) {
  const opts = parseArgs(argv);
  if (opts.help || !opts.action) {
    printHelp();
    return opts.help ? 0 : 1;
  }
  if (!opts.name) {
    process.stderr.write('Missing change name.\n');
    printHelp();
    return 1;
  }

  if (opts.action === 'new') {
    const result = createSpecsChange(opts.cwd, opts.name, { force: opts.force });
    process.stdout.write(
      `Created specs change "${result.name}" under ${result.dir}/changes/${result.name}/\n`,
    );
    for (const f of result.files) {
      process.stdout.write(`  ${f.status.padEnd(8)} ${f.file}\n`);
    }
    process.stdout.write(
      `\nNext: edit proposal.md / tasks.md, then:\n` +
        `  forge phase plan --plan-type specs --openspec ${result.name}\n`,
    );
    return 0;
  }

  if (opts.action === 'archive') {
    const result = archiveSpecsChange(opts.cwd, opts.name, { date: opts.date });
    process.stdout.write(`Archived ${result.from} → ${result.to}\n`);
    process.stdout.write(
      `If ADRs are enabled, run archive-to-adr on the archived folder.\n`,
    );
    return 0;
  }

  process.stderr.write(`Unknown action: ${opts.action}\n`);
  return 1;
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  try {
    process.exitCode = runChange(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
    process.exitCode = 1;
  }
}
