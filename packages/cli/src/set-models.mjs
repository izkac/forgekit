#!/usr/bin/env node
/**
 * Get or set the checkout-local Forge subagent billing preference.
 *
 * Usage:
 *   forge set-models              # print effective billing
 *   forge set-models included     # set local billing
 *   forge set-models metered
 *
 * Options:
 *   --forge-dir <path>  Forge root (default: .forge under cwd)
 *   --defaults <path>   Defaults JSON path
 *   --json              Machine-readable stdout for get
 *   --help
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BILLING_LANES,
  DEFAULTS_PATH,
  loadJsonFile,
  loadMergedConfig,
} from './resolve-model.mjs';

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const opts = {
    billing: null,
    forgeDir: null,
    defaults: null,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--forge-dir') opts.forgeDir = argv[++i];
    else if (arg === '--defaults') opts.defaults = argv[++i];
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--') continue;
    else if (!arg.startsWith('-') && opts.billing === null) opts.billing = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return opts;
}

/**
 * @param {{ forgeDir: string, billing: string }} opts
 */
export function writeLocalBilling(opts) {
  if (!BILLING_LANES.includes(opts.billing)) {
    throw new Error(`Unknown billing "${opts.billing}". Expected one of: ${BILLING_LANES.join(', ')}`);
  }

  fs.mkdirSync(opts.forgeDir, { recursive: true });
  const localPath = path.join(opts.forgeDir, 'models.local.json');

  /** @type {Record<string, unknown>} */
  let existing = {};
  if (fs.existsSync(localPath)) {
    existing = loadJsonFile(localPath);
  }

  const next = { ...existing, billing: opts.billing };
  fs.writeFileSync(localPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return { localPath, billing: opts.billing };
}

/**
 * @param {{ forgeDir?: string, defaultsPath?: string, cwd?: string }} [paths]
 */
export function getEffectiveBilling(paths = {}) {
  const { config, sources, localPath } = loadMergedConfig({
    defaultsPath: paths.defaultsPath,
    forgeDir: paths.forgeDir,
    cwd: paths.cwd,
  });
  const billing =
    typeof config.billing === 'string' && BILLING_LANES.includes(config.billing)
      ? config.billing
      : 'included';
  return {
    billing,
    localPath,
    localExists: fs.existsSync(localPath),
    source: sources,
  };
}

function printHelp() {
  process.stdout.write(`Usage: forge set-models [included|metered] [options]

Get or set checkout-local Forge subagent billing lane.

  forge models
      Print effective lane only — does NOT create .forge/models.local.json.
      Without a local file, this prints the committed default (usually "included").

  forge models included|metered
      Write/update .forge/models.local.json (gitignored, per-checkout).

  forge models -- --json
      Same get, with paths and localExists.

Defaults: models.defaults.json
Local overlay: .forge/models.local.json (appears only after a set)

Options:
  --forge-dir <path>  Forge directory (default: .forge)
  --defaults <path>   Defaults JSON path
  --json              JSON stdout when getting
  --help              Show help
`);
}

/**
 * @param {string[]} argv
 * @param {{ cwd?: string, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream }} [io]
 */
export function runSetModels(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const cwd = io.cwd ?? process.cwd();

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`${msg}\n`);
    return 2;
  }

  if (opts.help) {
    printHelp();
    return 0;
  }

  const forgeDir = opts.forgeDir ?? path.join(cwd, '.forge');
  const defaultsPath = opts.defaults ?? DEFAULTS_PATH;

  try {
    if (opts.billing) {
      const written = writeLocalBilling({ forgeDir, billing: opts.billing });
      stdout.write(`billing=${written.billing}\n`);
      stdout.write(`wrote ${written.localPath}\n`);
      return 0;
    }

    const effective = getEffectiveBilling({
      forgeDir,
      defaultsPath,
      cwd,
    });
    if (opts.json) {
      stdout.write(`${JSON.stringify(effective, null, 2)}\n`);
    } else {
      stdout.write(`billing=${effective.billing}\n`);
      if (effective.localExists) {
        stdout.write(`local=${effective.localPath}\n`);
      } else {
        stdout.write(`local=(none — using models.defaults.json)\n`);
        stdout.write(`hint: forge models included|metered  # writes .forge/models.local.json\n`);
      }
    }
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`${msg}\n`);
    return 1;
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  process.exitCode = runSetModels(process.argv.slice(2));
}
