#!/usr/bin/env node
/**
 * Specs-engine change scaffolding.
 *
 * Usage:
 *   forge change new <name> [--capability <id>]… [--cwd <path>] [--force]
 *   forge change archive <name> [--cwd <path>] [--date YYYY-MM-DD] [--no-sync]
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_SPECS_DIR,
  resolveProjectPlanEngine,
} from './plan-engine.mjs';
import { deltaSpecTemplate, mergeChangeDeltas } from './specs-sync.mjs';

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const opts = {
    help: false,
    force: false,
    noSync: false,
    cwd: process.cwd(),
    date: /** @type {string | null} */ (null),
    action: /** @type {string | null} */ (null),
    name: /** @type {string | null} */ (null),
    capabilities: /** @type {string[]} */ ([]),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--force' || arg === '-f') opts.force = true;
    else if (arg === '--no-sync') opts.noSync = true;
    else if (arg === '--cwd') opts.cwd = argv[++i];
    else if (arg === '--date') opts.date = argv[++i];
    else if (arg === '--capability' || arg === '--cap') {
      const cap = argv[++i];
      if (!cap) throw new Error(`${arg} requires a capability id`);
      opts.capabilities.push(cap);
    } else if (!opts.action && (arg === 'new' || arg === 'archive')) opts.action = arg;
    else if (!opts.name && !arg.startsWith('-')) opts.name = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function printHelp() {
  process.stdout.write(`Usage: forge change <new|archive> <name> [options]

Scaffold or archive a change for the built-in specs planning engine.
Layout matches OpenSpec: proposal / design / tasks / delta specs under
\`changes/<name>/specs/<capability>/spec.md\`, main catalog at
\`<plan.dir>/specs/\`.

Commands:
  new <name>       Create <plan.dir>/changes/<name>/{proposal,design,tasks}.md
                   plus delta stubs for each --capability
  archive <name>   Merge deltas → <plan.dir>/specs/, then move change to
                   changes/archive/YYYY-MM-DD-<name>

Options:
  --capability <id>  Delta capability to stub (repeatable). kebab-case id
                     matching OpenSpec domains (e.g. auth, payments)
  --cwd <path>       Project root (default: cwd)
  --date YYYY-MM-DD  Archive date prefix (default: today UTC)
  --no-sync          Archive without merging deltas into the main catalog
  --force, -f        Overwrite existing scaffold files on new
  --help

Requires \`.forge/config.json\` → plan.engine: specs (or run \`forge init --no-openspec\`).
Engine root is \`plan.dir\` (default \`specs\`; use \`openspec\` to reuse an
OpenSpec tree).
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

/**
 * @param {string} capability
 */
export function assertCapabilityName(capability) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(capability)) {
    throw new Error(
      `Capability id must be kebab-case (got: ${capability}). Example: auth`,
    );
  }
  return capability;
}

const PROPOSAL_TMPL = (title, capabilities) => {
  const caps =
    capabilities.length > 0
      ? capabilities.map((c) => `- \`${c}\`: … (delta: \`specs/${c}/spec.md\`)`).join('\n')
      : `- \`<capability>\`: … — add with \`forge change new … --capability <id>\` or create \`specs/<id>/spec.md\``;
  return `# ${title}

## Why

One or two paragraphs: problem / pressure.

## What Changes

- …

## Capabilities

${caps}

## Impact

Affected code/areas, risks, migration notes.
`;
};

const DESIGN_TMPL = `# Design

## Context

…

## Decisions

- Decision: …
  - Alternatives considered: …
  - Rationale: …

## Risks / Trade-offs

- …
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
 * @param {{ force?: boolean, capabilities?: string[] }} [opts]
 */
export function createSpecsChange(cwd, name, opts = {}) {
  assertChangeName(name);
  const capabilities = (opts.capabilities ?? []).map(assertCapabilityName);
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
  fs.mkdirSync(path.join(changeDir, 'specs'), { recursive: true });

  /** @type {{ file: string, status: string }[]} */
  const files = [];
  const write = (rel, body) => {
    const dest = path.join(changeDir, rel);
    if (fs.existsSync(dest) && !opts.force) {
      files.push({ file: `${dir}/changes/${name}/${rel}`, status: 'skipped' });
      return;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body, 'utf8');
    files.push({ file: `${dir}/changes/${name}/${rel}`, status: 'written' });
  };

  const title = name
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  write('proposal.md', PROPOSAL_TMPL(title, capabilities));
  write('design.md', DESIGN_TMPL);
  write('tasks.md', TASKS_TMPL);

  for (const cap of capabilities) {
    write(`specs/${cap}/spec.md`, deltaSpecTemplate(cap));
  }

  return { dir, changeDir, name, files, capabilities };
}

/**
 * @param {string} cwd
 * @param {string} name
 * @param {{ date?: string | null, noSync?: boolean }} [opts]
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
  const date = opts.date || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid --date (want YYYY-MM-DD): ${date}`);
  }

  /** @type {{ capability: string, status: string, file: string }[]} */
  let synced = [];
  if (!opts.noSync) {
    const mainSpecsDir = path.join(cwd, dir, 'specs');
    synced = mergeChangeDeltas(src, mainSpecsDir);
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
    synced,
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
    const result = createSpecsChange(opts.cwd, opts.name, {
      force: opts.force,
      capabilities: opts.capabilities,
    });
    process.stdout.write(
      `Created specs change "${result.name}" under ${result.dir}/changes/${result.name}/\n`,
    );
    for (const f of result.files) {
      process.stdout.write(`  ${f.status.padEnd(8)} ${f.file}\n`);
    }
    if (result.capabilities.length === 0) {
      process.stdout.write(
        `\nNo delta stubs yet — add with:\n` +
          `  forge change new ${result.name} --capability <domain> --force\n` +
          `or create ${result.dir}/changes/${result.name}/specs/<domain>/spec.md\n`,
      );
    }
    process.stdout.write(
      `\nNext: edit proposal.md / design.md / tasks.md / specs/, then:\n` +
        `  forge phase plan --plan-type specs --openspec ${result.name}\n`,
    );
    return 0;
  }

  if (opts.action === 'archive') {
    const result = archiveSpecsChange(opts.cwd, opts.name, {
      date: opts.date,
      noSync: opts.noSync,
    });
    for (const s of result.synced) {
      process.stdout.write(
        `  sync ${s.status.padEnd(8)} ${result.dir}/specs/${s.capability}/spec.md\n`,
      );
    }
    if (!opts.noSync && result.synced.length === 0) {
      process.stdout.write('  sync     (no delta specs to merge)\n');
    }
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
