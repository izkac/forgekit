#!/usr/bin/env node
/**
 * Enforce the project's subagent model policy at dispatch time (Claude Code).
 *
 * `forge resolve-model` is a *contract*: the coordinator is told to run it
 * before every subagent dispatch and pass back the model it returns. Measured
 * in the field, that step gets skipped — the coordinator passes a tier model it
 * remembers instead, and `.forge/models.local.json` has no observable effect.
 * This command closes the loop from the host side: wired as a PreToolUse hook
 * on the subagent tool, it reads the dispatch payload on stdin and answers with
 * a hook decision.
 *
 * The dispatch payload carries a model but no tier, so the intended tier can't
 * be recovered. Hence two rules, and nothing else:
 *
 *   - **All three tiers resolve to the same model** → nothing to decide; rewrite
 *     the dispatch to that model (or drop `model` when the cell is `inherit`).
 *   - **Tiers differ** → the model can only be validated, not corrected: deny a
 *     dispatch whose model is outside the resolved set, naming the set, so the
 *     coordinator re-dispatches via `forge resolve-model`.
 *
 * Without `.forge/models.local.json` the command is inert: it always allows,
 * before either rule is consulted. A project that has not opted in sees no
 * behavior change at all. Every failure path — unparseable payload, unreadable
 * config, unknown agent — also allows. A broken policy hook must never be able
 * to block work.
 *
 * Usage:
 *   forge enforce-model [options]        # PreToolUse payload on stdin
 *
 * Options:
 *   --billing <lane>    included | metered (default: merged config)
 *   --agent <name>      cursor | claude-code | codex (default: detect)
 *   --defaults <path>   Override defaults JSON path
 *   --forge-dir <path>  Forge root (default: .forge under cwd)
 *   --help              Show help
 *
 * Stdout: a PreToolUse hook decision, or nothing at all when the dispatch stands.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BILLING_LANES,
  TIERS,
  detectAgent,
  loadMergedConfig,
} from './resolve-model.mjs';
import { appendDispatch } from './metrics/dispatches.mjs';

/** Host tool names that dispatch a subagent. */
export const SUBAGENT_TOOLS = Object.freeze(['Agent', 'Task']);

/** How long to wait for the hook payload before giving up and allowing. */
export const STDIN_TIMEOUT_MS = 2000;

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const opts = {
    billing: null,
    agent: null,
    defaults: null,
    forgeDir: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--billing') opts.billing = argv[++i];
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
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The three tier cells for one (agent, billing) pair, in TIERS order.
 *
 * @param {Record<string, unknown>} config
 * @param {{ agent: string, billing: string }} sel
 * @returns {string[] | null} null when the config cannot answer
 */
export function tierCells(config, sel) {
  const agents = config?.agents;
  if (!isPlainObject(agents)) return null;
  const agentMap = agents[sel.agent];
  if (!isPlainObject(agentMap)) return null;
  const laneMap = agentMap[sel.billing];
  if (!isPlainObject(laneMap)) return null;

  /** @type {string[]} */
  const cells = [];
  for (const tier of TIERS) {
    const cell = laneMap[tier];
    if (typeof cell !== 'string' || cell === '') return null;
    cells.push(cell);
  }
  return cells;
}

/**
 * @typedef {(
 *   | { action: 'allow', reason?: string }
 *   | { action: 'pin', model: string | null }
 *   | { action: 'deny', reason: string }
 * )} Decision
 */

/**
 * @param {{
 *   cells: string[] | null,
 *   hasOverlay: boolean,
 *   model: string | null,
 *   agent?: string,
 *   billing?: string,
 * }} input
 * @returns {Decision}
 */
export function decide(input) {
  // Opting in is writing the overlay. Until then this command has no opinion —
  // not even about models outside the default table.
  if (!input.hasOverlay) return { action: 'allow', reason: 'no-overlay' };

  const cells = input.cells;
  if (!cells || cells.length !== TIERS.length) {
    return { action: 'allow', reason: 'unresolved' };
  }

  const model = input.model || null;
  const flattened = cells.every((cell) => cell === cells[0]);

  if (flattened) {
    // `inherit` means the host picks, which is expressed by omitting `model`.
    const want = cells[0] === 'inherit' ? null : cells[0];
    if (model === want) return { action: 'allow', reason: 'already-pinned' };
    return { action: 'pin', model: want };
  }

  // Tiers differ and the payload has no tier, so a dispatch that named no model
  // is indistinguishable from one that resolved to `inherit`. Leave it alone.
  if (!model) return { action: 'allow', reason: 'no-model' };
  if (cells.includes(model)) return { action: 'allow', reason: 'in-set' };

  const table = TIERS.map((tier, i) => `${tier}=${cells[i]}`).join(', ');
  const where = input.agent && input.billing ? ` for (${input.agent}, ${input.billing})` : '';
  return {
    action: 'deny',
    reason:
      `This project's .forge/models.local.json resolves ${table}${where}. ` +
      `The dispatch asked for "${model}", which is not one of them. ` +
      'Run `forge resolve-model --tier <fast|standard|capable>` and pass the ' +
      'model it returns (omit the model parameter when omitModel is true).',
  };
}

/**
 * Translate a decision into the JSON a PreToolUse hook writes on stdout.
 *
 * @param {Decision} decision
 * @param {Record<string, unknown>} toolInput
 * @returns {Record<string, unknown> | null} null when nothing should be written
 */
export function hookOutput(decision, toolInput) {
  if (decision.action === 'pin') {
    /** @type {Record<string, unknown>} */
    const updatedInput = { ...toolInput };
    if (decision.model === null) delete updatedInput.model;
    else updatedInput.model = decision.model;
    return {
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput,
      },
    };
  }

  if (decision.action === 'deny') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.reason,
      },
    };
  }

  return null;
}

/**
 * Decide on one hook payload.
 *
 * @param {string} raw stdin contents
 * @param {{
 *   billing?: string | null,
 *   agent?: string | null,
 *   defaultsPath?: string,
 *   forgeDir?: string,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 * }} opts
 * @returns {{ decision: Decision, toolInput: Record<string, unknown>,
 *   dispatch: { tool: string, agentType: string | null, toolUseId: string | null } | null }}
 *   `dispatch` describes the subagent dispatch this payload actually is, and is
 *   null when the payload was not one — an unparseable body, another tool, or
 *   no input at all. It is what the dispatch ledger records; there is nothing
 *   to record about a payload that never asked for a subagent.
 */
export function enforceModel(raw, opts = {}) {
  /** @type {Record<string, unknown>} */
  const empty = {};

  let payload;
  try {
    payload = JSON.parse(raw || '');
  } catch {
    return { decision: { action: 'allow', reason: 'unparseable' }, toolInput: empty, dispatch: null };
  }
  if (!isPlainObject(payload)) {
    return { decision: { action: 'allow', reason: 'unparseable' }, toolInput: empty, dispatch: null };
  }

  const toolName = payload.tool_name;
  if (typeof toolName === 'string' && !SUBAGENT_TOOLS.includes(toolName)) {
    return { decision: { action: 'allow', reason: 'other-tool' }, toolInput: empty, dispatch: null };
  }

  const toolInput = payload.tool_input;
  if (!isPlainObject(toolInput)) {
    return { decision: { action: 'allow', reason: 'no-input' }, toolInput: empty, dispatch: null };
  }

  // Identifiers only. `prompt` and `description` are free-form text and the
  // ledger outlives nothing it should be able to leak.
  const dispatch = {
    tool: typeof toolName === 'string' ? toolName : SUBAGENT_TOOLS[0],
    agentType: typeof toolInput.subagent_type === 'string' ? toolInput.subagent_type : null,
    toolUseId: typeof payload.tool_use_id === 'string' ? payload.tool_use_id : null,
  };

  let config;
  let sources;
  let localPath;
  try {
    ({ config, sources, localPath } = loadMergedConfig({
      defaultsPath: opts.defaultsPath,
      forgeDir: opts.forgeDir,
      cwd: opts.cwd,
    }));
  } catch {
    return { decision: { action: 'allow', reason: 'unreadable-config' }, toolInput, dispatch };
  }

  const hasOverlay = sources.includes(localPath);
  const agent = opts.agent ?? detectAgent(opts.env ?? process.env).agent;
  const defaultBilling =
    typeof config.billing === 'string' && BILLING_LANES.includes(config.billing)
      ? config.billing
      : 'included';
  const billing = opts.billing ?? defaultBilling;

  const model = typeof toolInput.model === 'string' ? toolInput.model : null;
  const decision = decide({
    cells: tierCells(config, { agent, billing }),
    hasOverlay,
    model,
    agent,
    billing,
  });

  return { decision, toolInput, dispatch };
}

/** Ledger names for the three actions — `pin` reads as what it does to a dispatch. */
const LEDGER_DECISION = { allow: 'allow', pin: 'rewrite', deny: 'deny' };

/**
 * One dispatch, as the ledger records it.
 *
 * `modelResolved` is the model the dispatch actually ends up running under:
 * what was asked for when nothing was corrected, the pinned model when it was,
 * and nothing at all when the dispatch was refused. Comparing it to
 * `modelRequested` is how a later analysis answers whether the policy was
 * honoured without anyone having to have logged an intention.
 *
 * The deny reason the coordinator is shown is a paragraph of guidance; the
 * ledger keeps a code, because this file is read in bulk.
 *
 * @param {{ decision: Decision, toolInput: Record<string, unknown>,
 *   dispatch: { tool: string, agentType: string | null, toolUseId: string | null } }} result
 * @returns {Record<string, any>}
 */
export function dispatchRow(result) {
  const { decision, toolInput, dispatch } = result;
  const requested = typeof toolInput.model === 'string' ? toolInput.model : null;
  const resolved =
    decision.action === 'pin' ? decision.model : decision.action === 'deny' ? null : requested;
  const reason =
    decision.action === 'pin'
      ? 'flattened-tiers'
      : decision.action === 'deny'
        ? 'outside-resolved-set'
        : (decision.reason ?? null);

  return {
    tool: dispatch.tool,
    agentType: dispatch.agentType,
    modelRequested: requested,
    modelResolved: resolved,
    decision: LEDGER_DECISION[decision.action] ?? decision.action,
    reason,
    toolUseId: dispatch.toolUseId,
  };
}

/**
 * @param {NodeJS.ReadableStream & { isTTY?: boolean }} stream
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
export function readStdin(stream, timeoutMs = STDIN_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!stream || stream.isTTY) return resolve('');
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      // Clear rather than unref: an armed timer would keep a finished hook
      // sitting on the dispatch's critical path for the rest of the window.
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      data += String(chunk);
    });
    stream.on('end', finish);
    stream.on('error', finish);
  });
}

function printHelp() {
  process.stdout.write(`Usage: forge enforce-model [options]

PreToolUse hook body: reads a subagent dispatch payload on stdin and enforces
the project's .forge/models.local.json against it.

  All tiers same model  → rewrite the dispatch to it
  Tiers differ          → deny a model outside the resolved set, with guidance
  No models.local.json  → allow, always

Options:
  --billing <lane>    included | metered (default: from config, else included)
  --agent <name>      cursor | claude-code | codex (default: detect)
  --defaults <path>   Path to defaults JSON
  --forge-dir <path>  Forge directory containing models.local.json
  --help              Show help

Stdout: PreToolUse hook JSON, or nothing when the dispatch stands.
`);
}

/**
 * @param {string[]} argv
 * @param {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   input?: string,
 *   stdin?: NodeJS.ReadableStream,
 *   stdout?: NodeJS.WritableStream,
 *   stderr?: NodeJS.WritableStream,
 * }} [io]
 * @returns {Promise<number>}
 */
export async function runEnforceModel(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;

  let opts;
  try {
    opts = parseArgs(argv);
  } catch {
    // Even a malformed hook registration must not stand between the
    // coordinator and its subagent.
    return 0;
  }

  if (opts.help) {
    printHelp();
    return 0;
  }

  const raw = io.input ?? (await readStdin(io.stdin ?? process.stdin));

  let result;
  try {
    result = enforceModel(raw, {
      billing: opts.billing,
      agent: opts.agent,
      defaultsPath: opts.defaults ?? undefined,
      forgeDir: opts.forgeDir ?? undefined,
      cwd: io.cwd,
      env: io.env,
    });
  } catch {
    return 0;
  }

  const out = hookOutput(result.decision, result.toolInput);
  if (out) stdout.write(`${JSON.stringify(out)}\n`);

  // Deliberately after the decision is out the door, and deliberately not
  // gated on the overlay: "how often is forge resolve-model skipped" is most
  // worth knowing in a project that has not opted into enforcement yet.
  // `appendDispatch` swallows its own failures; this guard is for everything
  // else, because nothing below the decision may change the decision.
  if (result.dispatch) {
    try {
      appendDispatch(dispatchRow(result), {
        forgeDir: opts.forgeDir ?? undefined,
        cwd: io.cwd,
      });
    } catch {
      // a measurement lost, never a subagent
    }
  }
  return 0;
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  process.exitCode = await runEnforceModel(process.argv.slice(2));
}
