#!/usr/bin/env node
/**
 * Signals pre-flight: map a review scope to the workspaces it touches and emit
 * the deterministic grounding commands (typecheck / lint / test) to run before
 * the scout. Grounding the scout in real tool output cuts hallucinated findings
 * and raises recall on the smells / contracts / tests lenses.
 *
 * Read-only and fast: it PLANS the commands rather than running them, so the
 * agent can run exactly the relevant ones and read full output. Use `--json`
 * for machine-readable output.
 *
 * Usage:
 *   review signals [--paths a,b] [--type <t>] [--base-branch main] [--json]
 */

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mapPathsToWorkspaces, suggestSignalCommands } from './lib.mjs';
import { loadWorkspaces } from '../lib/workspaces.mjs';

const CONTRACT_HINT = /(contract|openapi|routes?\/|\.openapi\.)/i;

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const opts = { paths: null, type: 'uncommitted', baseBranch: 'main', json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--paths') opts.paths = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--type') opts.type = argv[++i];
    else if (arg === '--base-branch') opts.baseBranch = argv[++i];
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

/**
 * @param {ReturnType<typeof parseArgs>} opts
 * @param {string} cwd
 * @returns {string[]}
 */
function resolveScopePaths(opts, cwd) {
  if (opts.paths) return opts.paths;
  const run = (args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    if (opts.type === 'branch') {
      return run(['diff', '--name-only', `${opts.baseBranch}...HEAD`]).split('\n').filter(Boolean);
    }
    const tracked = run(['diff', '--name-only', 'HEAD']).split('\n').filter(Boolean);
    const untracked = run(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
    return [...new Set([...tracked, ...untracked])];
  } catch {
    return [];
  }
}

/**
 * @param {ReturnType<typeof parseArgs>} opts
 * @param {string} [cwd]
 * @param {Array<{ name: string, dir: string, scripts?: Record<string, string> }>} [packagesOverride]
 * @returns {{ exitCode: number, plan: Record<string, unknown>, message: string }}
 */
export function runSignals(opts, cwd = process.cwd(), packagesOverride) {
  const paths = resolveScopePaths(opts, cwd);
  const packages = packagesOverride ?? loadWorkspaces(cwd);
  const { workspaces, unmatched } = mapPathsToWorkspaces(paths, packages);
  const commands = suggestSignalCommands(workspaces);
  const contractTouch = paths.some((p) => CONTRACT_HINT.test(p));

  const notes = [];
  if (contractTouch) {
    notes.push('Contract/route files touched — verify OpenAPI route-parity (contracts lens).');
  }
  if (unmatched.length > 0) {
    notes.push(`${unmatched.length} path(s) outside any workspace — review with root tooling.`);
  }

  const plan = {
    scope_paths: paths,
    workspaces: workspaces.map((w) => w.name),
    commands,
    notes,
  };

  if (opts.json) {
    return { exitCode: 0, plan, message: JSON.stringify(plan, null, 2) };
  }

  const lines = [];
  lines.push(`Signals pre-flight — ${paths.length} path(s) in scope`);
  lines.push(`Workspaces: ${workspaces.length ? workspaces.map((w) => w.name).join(', ') : '(none)'}`);
  lines.push('');
  lines.push('Run these grounding commands, then convert failures to tentative findings:');
  if (commands.length === 0) lines.push('  (no workspace scripts detected for the scope)');
  for (const c of commands) lines.push(`  ${c}`);
  if (notes.length > 0) {
    lines.push('');
    lines.push('Notes:');
    for (const n of notes) lines.push(`  - ${n}`);
  }

  return { exitCode: 0, plan, message: lines.join('\n') };
}

function printHelp() {
  console.log(`Usage: review signals [options]

Plan the deterministic grounding commands for a review scope.

Options:
  --paths a,b         Comma list of scoped paths (default: detect from git)
  --type <t>          uncommitted | branch (git detection mode; default: uncommitted)
  --base-branch <b>   Merge base for --type branch (default: main)
  --json              Machine-readable output
  -h, --help          Show this help
`);
}

function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      printHelp();
      process.exit(0);
    }
    const result = runSignals(opts);
    console.log(result.message);
    process.exit(result.exitCode);
  } catch (err) {
    console.error(/** @type {Error} */ (err).message);
    process.exit(1);
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main();
}
