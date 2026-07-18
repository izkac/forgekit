#!/usr/bin/env node
/**
 * Resolve Forge subagent model from capability tier × billing lane.
 *
 * Usage:
 *   forge resolve-model --tier <fast|standard|capable> [options]
 *
 * Options:
 *   --tier <tier>       Capability tier (required)
 *   --billing <lane>    included | metered (default: merged config)
 *   --agent <name>      cursor | claude-code | codex (default: detect)
 *   --defaults <path>   Override defaults JSON path
 *   --forge-dir <path>  Forge root (default: .forge under cwd)
 *   --help              Show help
 *
 * Stdout: single JSON object { agent, billing, tier, model, omitModel, source }
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const TIERS = Object.freeze(['fast', 'standard', 'capable']);
export const BILLING_LANES = Object.freeze(['included', 'metered']);
export const AGENTS = Object.freeze(['cursor', 'claude-code', 'codex']);

export const DEFAULTS_PATH = path.join(__dirname, 'models.defaults.json');

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const opts = {
    tier: null,
    billing: null,
    agent: null,
    defaults: null,
    forgeDir: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tier') opts.tier = argv[++i];
    else if (arg === '--billing') opts.billing = argv[++i];
    else if (arg === '--agent') opts.agent = argv[++i];
    else if (arg === '--defaults') opts.defaults = argv[++i];
    else if (arg === '--forge-dir') opts.forgeDir = argv[++i];
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--') continue;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return opts;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ agent: string, detected: boolean }}
 */
export function detectAgent(env = process.env) {
  if (env.CURSOR_AGENT === '1' || env.CURSOR_TRACE_ID || env.CURSOR_SESSION_ID) {
    return { agent: 'cursor', detected: true };
  }
  if (env.CLAUDE_CODE === '1' || env.CLAUDECODE || env.CLAUDE_PROJECT_DIR) {
    return { agent: 'claude-code', detected: true };
  }
  if (env.CODEX_HOME || env.CODEX_CI || env.CODEX_SANDBOX) {
    return { agent: 'codex', detected: true };
  }
  // Cursor Agent often sets these; fall back when running inside Cursor IDE shell.
  if (env.TERM_PROGRAM === 'vscode' && (env.VSCODE_GIT_IPC_HANDLE || env.VSCODE_PID)) {
    return { agent: 'cursor', detected: true };
  }
  return { agent: 'cursor', detected: false };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deep-merge local overlay onto defaults (objects only; arrays/scalars replaced).
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} overlay
 */
export function deepMerge(base, overlay) {
  /** @type {Record<string, unknown>} */
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(
        /** @type {Record<string, unknown>} */ (out[key]),
        /** @type {Record<string, unknown>} */ (value),
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * @param {string} filePath
 * @returns {Record<string, unknown>}
 */
export function loadJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing config file: ${filePath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in ${filePath}: ${msg}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Config root must be an object: ${filePath}`);
  }
  return parsed;
}

/**
 * @param {{ defaultsPath?: string, forgeDir?: string, cwd?: string }} [paths]
 */
export function loadMergedConfig(paths = {}) {
  const defaultsPath = paths.defaultsPath ?? DEFAULTS_PATH;
  const cwd = paths.cwd ?? process.cwd();
  const forgeDir = paths.forgeDir ?? path.join(cwd, '.forge');
  const localPath = path.join(forgeDir, 'models.local.json');

  const defaults = loadJsonFile(defaultsPath);
  /** @type {string[]} */
  const sources = [defaultsPath];

  let merged = defaults;
  if (fs.existsSync(localPath)) {
    const local = loadJsonFile(localPath);
    merged = deepMerge(defaults, local);
    sources.push(localPath);
  }

  return { config: merged, sources, localPath };
}

/**
 * @param {Record<string, unknown>} config
 * @param {{ agent: string, billing: string, tier: string }} sel
 */
export function resolveFromConfig(config, sel) {
  const { agent, billing, tier } = sel;
  if (!AGENTS.includes(agent)) {
    throw new Error(`Unknown agent "${agent}". Expected one of: ${AGENTS.join(', ')}`);
  }
  if (!BILLING_LANES.includes(billing)) {
    throw new Error(`Unknown billing "${billing}". Expected one of: ${BILLING_LANES.join(', ')}`);
  }
  if (!TIERS.includes(tier)) {
    throw new Error(`Unknown tier "${tier}". Expected one of: ${TIERS.join(', ')}`);
  }

  const agents = config.agents;
  if (!isPlainObject(agents)) {
    throw new Error('Config missing agents object');
  }
  const agentMap = agents[agent];
  if (!isPlainObject(agentMap)) {
    throw new Error(`Missing agent map for "${agent}"`);
  }
  const laneMap = agentMap[billing];
  if (!isPlainObject(laneMap)) {
    throw new Error(`Missing billing map for (${agent}, ${billing})`);
  }
  const cell = laneMap[tier];
  if (cell === undefined || cell === null || cell === '') {
    throw new Error(`Missing cell for (${agent}, ${billing}, ${tier})`);
  }
  if (typeof cell !== 'string') {
    throw new Error(`Cell for (${agent}, ${billing}, ${tier}) must be a string`);
  }

  const inherit = cell === 'inherit';
  return {
    agent,
    billing,
    tier,
    model: inherit ? null : cell,
    omitModel: inherit,
  };
}

/**
 * @param {{
 *   tier: string,
 *   billing?: string | null,
 *   agent?: string | null,
 *   defaultsPath?: string,
 *   forgeDir?: string,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 * }} opts
 */
export function resolveModel(opts) {
  if (!opts.tier) {
    throw new Error('--tier is required (fast | standard | capable)');
  }

  const { config, sources } = loadMergedConfig({
    defaultsPath: opts.defaultsPath,
    forgeDir: opts.forgeDir,
    cwd: opts.cwd,
  });

  let agent = opts.agent ?? null;
  let agentDetected = Boolean(agent);
  if (!agent) {
    const detected = detectAgent(opts.env ?? process.env);
    agent = detected.agent;
    agentDetected = detected.detected;
  }

  const defaultBilling =
    typeof config.billing === 'string' && BILLING_LANES.includes(config.billing)
      ? config.billing
      : 'included';
  const billing = opts.billing ?? defaultBilling;

  const resolved = resolveFromConfig(config, {
    agent,
    billing,
    tier: opts.tier,
  });

  return {
    ...resolved,
    source: sources,
    agentDetected,
  };
}

function printHelp() {
  process.stdout.write(`Usage: forge resolve-model --tier <fast|standard|capable> [options]

Resolve a subagent model for Forge (capability × billing).

Options:
  --tier <tier>       fast | standard | capable (required)
  --billing <lane>    included | metered (default: from config, else included)
  --agent <name>      cursor | claude-code | codex (default: detect)
  --defaults <path>   Path to defaults JSON
  --forge-dir <path>  Forge directory containing models.local.json
  --help              Show help

Stdout: JSON { agent, billing, tier, model, omitModel, source, agentDetected }
`);
}

/**
 * @param {string[]} argv
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream }} [io]
 */
export function runResolveModel(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;

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

  try {
    const result = resolveModel({
      tier: opts.tier,
      billing: opts.billing,
      agent: opts.agent,
      defaultsPath: opts.defaults ?? undefined,
      forgeDir: opts.forgeDir ?? undefined,
      cwd: io.cwd,
      env: io.env,
    });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
  process.exitCode = runResolveModel(process.argv.slice(2));
}
