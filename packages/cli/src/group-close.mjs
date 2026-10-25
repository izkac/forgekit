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
import { isReviewUnit } from './review-label.mjs';
import { readStamps } from './review-stamp.mjs';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const USAGE = 'Usage: forge group close --group <name> [--tasks <ids>] [--session <id>]\n';

/** Phases where the product-loop gates must already be green (see review-precheck-cli.mjs). */
const TAIL_PHASES = ['verify', 'review', 'finish', 'done'];

/**
 * The integrity problems that only the verify phase satisfies: the spine and
 * e2e files are authored and the loop is run there, so during implement they are
 * expected to be missing or not yet run. Matched against the problem strings
 * `runIntegrityChecks` / `checkE2eGate` emit. Every other problem — a guarded
 * file edited without an allowance, a tampered seal, an unresolved deferral, a
 * malformed spine, a failed e2e run — is a real defect and stops a group close.
 */
export const VERIFY_ONLY_INTEGRITY = [
  /^spine\.json required at /,
  /^e2e\.json required at /,
  /^e2e-results\.json missing\b/,
  /^e2e-results\.json is stale\b/,
];

/**
 * Judge a collected precheck.
 *
 * @param {ReturnType<typeof collectPrecheck>} pre
 * @param {string} phase
 * @returns {{ failRows: string[], blocking: string[], informational: string[], stop: boolean }}
 */
function judgePrecheck(pre, phase) {
  const failRows = pre.tasks.filter((t) => !t.ok).map((t) => `${t.task}: ${t.detail}`);
  const integrity = pre.integrity?.ok === false ? pre.integrity.problems : [];
  const tail = TAIL_PHASES.includes(phase);
  const isVerifyOnly = (/** @type {string} */ p) => VERIFY_ONLY_INTEGRITY.some((re) => re.test(p));
  const blocking = integrity.filter((p) => tail || !isVerifyOnly(p));
  const informational = integrity.filter((p) => !blocking.includes(p));
  return { failRows, blocking, informational, stop: failRows.length > 0 || blocking.length > 0 };
}

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

  // --- 0. the cheap checks, BEFORE anything is committed ---
  // A commit is not undone by a later failure, and a retry's range would then
  // start after it. So the inputs that can only fail the label or precheck step
  // are judged first: a name the label cannot carry, and a precheck that stops.
  if (!isReviewUnit(group)) {
    return fail(
      'label',
      `not a usable review unit: ${JSON.stringify(group)} — units are letters, digits, dot, dash and underscore (e.g. group-03).`,
    );
  }
  const first = loadSession(sessionId);
  const early = precheckStep(cwd, first.dir, first.session);
  if (!early.ok) return fail('precheck', early.detail);

  // A retry: the last checkpoint already carries this group's name (an earlier
  // run committed it, then a later step or a reviewer sent it back). Its work is
  // part of this group, so the range starts where that checkpoint's did.
  const earlier = Array.isArray(first.session.checkpoints) ? first.session.checkpoints : [];
  let runStart = earlier.length;
  while (runStart > 0 && earlier[runStart - 1].group === group) runStart -= 1;
  const retryBase =
    runStart < earlier.length ? (earlier[runStart - 1]?.sha ?? first.session.baseCommit ?? null) : null;

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
  if (committed && retryBase) {
    block.reviewTarget = `${retryBase}..${committed.sha}`;
  } else if (committed) {
    block.reviewTarget = committed.groupRange;
  } else {
    const checkpoints = Array.isArray(session.checkpoints) ? session.checkpoints : [];
    const base = retryBase ?? (checkpoints.length ? checkpoints[checkpoints.length - 1].sha : session.baseCommit);
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
  const checked = precheckStep(cwd, sessionDir, session);
  if (!checked.ok) return fail('precheck', checked.detail);
  const { pre, informational } = checked;
  block.precheck =
    informational.length === 0 ? 'OK' : `PROBLEMS (${informational.length}, informational before verify)`;
  if (informational.length > 0) block.precheckNotes = informational.map((p) => `  - ${p}`).join('\n');

  // --- 4. label ---
  // Group reviewers are standard tier; capable only for high-risk work (the
  // precheck's own reading of the plan), as phases/implement.md has it.
  const tier = pre.highRisk ? 'capable' : 'standard';
  const label = runSibling('review-label-cli.mjs', ['--session', sessionId, '--tier', tier, group], cwd);
  if (label.status !== 0) return fail('label', whyFailed(label));
  block.label = label.stdout.trim();
  const stamp = readStamps(sessionDir)
    .reverse()
    .find((s) => s.label === block.label);
  block.tier = stamp?.model?.tier ?? `${tier} (requested; the model could not be resolved)`;

  return { ok: true, block };
}

/**
 * Collect and judge the precheck. A failure carries every problem line.
 *
 * @param {string} cwd
 * @param {string} sessionDir
 * @param {Record<string, any>} session
 * @returns {{ ok: false, detail: string } |
 *   { ok: true, pre: ReturnType<typeof collectPrecheck>, informational: string[] }}
 */
function precheckStep(cwd, sessionDir, session) {
  let pre;
  try {
    pre = collectPrecheck({ cwd, sessionDir, session });
  } catch (err) {
    return { ok: false, detail: `could not collect the precheck: ${err instanceof Error ? err.message : err}` };
  }
  const judged = judgePrecheck(pre, String(session.phase));
  if (judged.stop) {
    const all = [...judged.failRows, ...judged.blocking, ...judged.informational];
    return { ok: false, detail: `PROBLEMS (${all.length})\n${all.map((p) => `  - ${p}`).join('\n')}` };
  }
  return { ok: true, pre, informational: judged.informational };
}

/** @param {Record<string, string>} block */
function renderBlock(block) {
  const lines = [
    `checkpoint:   ${block.checkpoint}`,
    `reviewTarget: ${block.reviewTarget}`,
    `precheck:     ${block.precheck}`,
    ...(block.precheckNotes ? [block.precheckNotes] : []),
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
