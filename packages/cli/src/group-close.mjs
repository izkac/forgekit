#!/usr/bin/env node
/**
 * `forge group close --group <name> [--tasks <ids>] [--session <id>]` — close a
 * task group in one call instead of four.
 *
 * Runs, in order, and stops at the first step that fails:
 *   1. checkpoint  the group commit, when `git.checkpoint` is enabled
 *                  (`forge checkpoint --group <name> --tasks <ids>`)
 *   2. range       the diff the group reviewer should read (`reviewTarget`)
 *   3. precheck    the machine-verified facts (`forge review-precheck`)
 *   4. label       the reviewer's Task description and tier (`forge review-label <name>`)
 * then prints one short block. The group name is also the review unit, so it
 * must be a usable one (`group-03`, `02-review-claims`).
 *
 * ORDER, AND WHAT THE RANGE COVERS. The old flow reviewed a group *before* its
 * checkpoint, so `forge checkpoint --range --last` handed the reviewer the
 * dirty working tree. Here the checkpoint comes first, and once it has
 * committed, `--range --last` would be `<this checkpoint>..HEAD` — empty. So
 * when this call made a commit the range is that commit's own `groupRange`
 * (previous checkpoint or base, to the new sha); when nothing was committed
 * (checkpointing off, or a clean tree) it is the `--range --last` answer. Either
 * way the target covers exactly this group.
 *
 * Step 1 and step 4 are spawned sibling CLIs (`checkpoint.mjs`,
 * `review-label-cli.mjs`): both are scripts that decide with `process.exit` and
 * the label one stamps the dispatch as a side effect, so spawning keeps their
 * behavior identical to running them by hand. Steps 2 and 3 call the exported
 * functions (`reviewTargetFor`, `collectPrecheck`) in-process.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { pendingEntries, reviewTargetFor } from './checkpoint.mjs';
import { loadProjectConfig } from './config.mjs';
import { loadSession, REPO_ROOT, resolveSessionOrExit } from './lib.mjs';
import { collectPrecheck } from './review-precheck.mjs';
import { readStamps } from './review-stamp.mjs';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const USAGE = 'Usage: forge group close --group <name> [--tasks <ids>] [--session <id>]\n';

/** Phases where the product-loop gates must already be green (see review-precheck-cli.mjs). */
const TAIL_PHASES = ['verify', 'review', 'finish', 'done'];

/**
 * Run a sibling CLI script to completion from the project root.
 *
 * @param {string} script file name under `src/`
 * @param {string[]} args
 * @param {string} cwd
 */
function runSibling(script, args, cwd) {
  return spawnSync(process.execPath, [path.join(SRC, script), ...args], { cwd, encoding: 'utf8' });
}

/**
 * The most useful sentence a failed child left behind.
 *
 * @param {{ stdout?: string, stderr?: string, error?: Error }} r
 */
function whyFailed(r) {
  return (r.stderr || '').trim() || (r.stdout || '').trim() || String(r.error?.message ?? 'no output');
}

/**
 * Close a group. Never throws and never exits: the CLI wrapper prints.
 *
 * @param {{ cwd?: string, sessionId: string, group: string, tasks?: string }} opts
 * @returns {{ ok: true, block: Record<string, string> } |
 *   { ok: false, step: 'checkpoint' | 'range' | 'precheck' | 'label', detail: string }}
 */
export function closeGroup(opts) {
  const cwd = opts.cwd ?? REPO_ROOT;
  const { sessionId, group } = opts;
  /** @type {Record<string, string>} */
  const block = {};
  /** @param {'checkpoint' | 'range' | 'precheck' | 'label'} step @param {string} detail */
  const fail = (step, detail) => ({ ok: /** @type {const} */ (false), step, detail });

  // --- 1. checkpoint ---
  let committed = null;
  const mode = loadProjectConfig(cwd)?.git?.checkpoint ?? 'off';
  if (mode === 'off') {
    block.checkpoint = 'skipped (git.checkpoint is off)';
  } else {
    const r = runSibling(
      'checkpoint.mjs',
      ['--session', sessionId, '--group', group, ...(opts.tasks ? ['--tasks', opts.tasks] : [])],
      cwd,
    );
    if (r.status !== 0) return fail('checkpoint', whyFailed(r));
    try {
      const out = JSON.parse(r.stdout);
      if (out.committed === true) {
        committed = out;
        block.checkpoint = `committed ${String(out.sha).slice(0, 7)} (${out.files.length} file(s))`;
      } else {
        block.checkpoint = `nothing committed — ${out.reason ?? 'no pending changes'}`;
      }
    } catch {
      return fail('checkpoint', `unreadable checkpoint output: ${r.stdout.trim().slice(0, 200)}`);
    }
  }

  // The checkpoint rewrote session.json; every later step reads it fresh.
  const { dir: sessionDir, session } = loadSession(sessionId);

  // --- 2. range ---
  if (committed) {
    block.reviewTarget = committed.groupRange;
  } else {
    const checkpoints = Array.isArray(session.checkpoints) ? session.checkpoints : [];
    const base = checkpoints.length ? checkpoints[checkpoints.length - 1].sha : session.baseCommit;
    if (!base) {
      return fail('range', 'no base commit recorded — this session started before checkpoints, so the reviewer reads the working tree (git diff).');
    }
    let pending = [];
    try {
      pending = pendingEntries(cwd);
    } catch {
      /* not a git repo / unreadable — fall back to the bare commit range, as --range does */
    }
    block.reviewTarget = reviewTargetFor(base, pending);
  }

  // --- 3. precheck ---
  let pre;
  try {
    pre = collectPrecheck({ cwd, sessionDir, session });
  } catch (err) {
    return fail('precheck', `could not collect the precheck: ${err instanceof Error ? err.message : err}`);
  }
  const failRows = pre.tasks.filter((t) => !t.ok).map((t) => `${t.task}: ${t.detail}`);
  const integrity = pre.integrity?.ok === false ? pre.integrity.problems : [];
  const problems = [...failRows, ...integrity];
  // Same rule as `forge review-precheck`'s exit code: integrity problems stop
  // the sequence from verify on; during implement the e2e/spine gates cannot be
  // green yet, so they are reported but do not stop a group from closing. A FAIL
  // task row always stops it.
  const stop = failRows.length > 0 || (integrity.length > 0 && TAIL_PHASES.includes(String(session.phase)));
  if (stop) {
    return fail('precheck', `PROBLEMS (${problems.length})\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  block.precheck =
    problems.length === 0 ? 'OK' : `PROBLEMS (${problems.length}, informational before verify)`;

  // --- 4. label ---
  const label = runSibling('review-label-cli.mjs', ['--session', sessionId, group], cwd);
  if (label.status !== 0) return fail('label', whyFailed(label));
  block.label = label.stdout.trim();
  const stamp = readStamps(sessionDir)
    .reverse()
    .find((s) => s.label === block.label);
  block.tier = stamp?.model?.tier ?? 'unknown (model could not be resolved)';

  return { ok: true, block };
}

/** @param {Record<string, string>} block */
function renderBlock(block) {
  const lines = [
    `checkpoint:   ${block.checkpoint}`,
    `reviewTarget: ${block.reviewTarget}`,
    `precheck:     ${block.precheck}`,
    `label:        ${block.label}`,
    `tier:         ${block.tier}`,
  ];
  return `${lines.join('\n')}\n`;
}

function runCli() {
  const args = process.argv.slice(2);
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (args[0] !== 'close') {
    process.stderr.write(`${USAGE}`);
    process.exit(1);
  }
  /** @type {{ group?: string, tasks?: string }} */
  const opts = {};
  let sessionId = null;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === '--group' && args[i + 1]) opts.group = args[(i += 1)];
    else if (args[i] === '--tasks' && args[i + 1]) opts.tasks = args[(i += 1)];
    else if (args[i] === '--session' && args[i + 1]) sessionId = args[(i += 1)];
    else {
      process.stderr.write(`Unknown argument: ${args[i]}\n${USAGE}`);
      process.exit(1);
    }
  }
  if (!opts.group) {
    process.stderr.write(`--group <name> is required.\n${USAGE}`);
    process.exit(1);
  }

  // Strict: step 1 makes a git commit, so an ambiguous session is a refusal.
  sessionId = resolveSessionOrExit(sessionId, { command: 'forge group close', strict: true });
  const result = closeGroup({ sessionId, group: opts.group, tasks: opts.tasks });
  if (!result.ok) {
    process.stderr.write(`forge group close: step "${result.step}" failed — ${result.detail}\n`);
    process.exit(1);
  }
  process.stdout.write(renderBlock(result.block));
}

// Importing this module for `closeGroup` must not run the CLI.
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) runCli();
