#!/usr/bin/env node
/**
 * `forge checkpoint` — an authorized, boring commit at a task-group boundary.
 *
 * Forge forbids autonomous commits, which is right, but the missing half was
 * an *explicit* one: a 32-task session accumulated 6k lines across 37 files
 * and 18 untracked ones in a single working tree, so a stray `git checkout`
 * could erase a day of work and every reviewer after task 1 saw a diff
 * containing all previous tasks.
 *
 * Checkpoints are opt-in per project (`.forge/config.json` → `git.checkpoint`),
 * never push, never run on the default branch unless explicitly allowed, and
 * record the resulting sha on the session so reviewers get a real diff range.
 *
 * Usage:
 *   forge checkpoint --group <name> [--tasks <ids>] [--message <subject>]
 *   forge checkpoint --dry-run
 *   forge checkpoint --range [--last]
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadSession, resolveSessionOrExit, REPO_ROOT, saveSession } from './lib.mjs';
import { loadProjectConfig } from './config.mjs';

const MODES = ['off', 'per-group', 'per-task'];
const DEFAULT_BRANCHES = new Set(['main', 'master']);

function usage() {
  process.stderr.write(
    `Usage:
  forge checkpoint --group <name> [--tasks <ids>] [--message <subject>]
  forge checkpoint --dry-run                 what would be committed
  forge checkpoint --range [--last]          diff range for a reviewer brief

Enable per project in .forge/config.json:
  { "git": { "checkpoint": "per-group" } }   # or "per-task", "off" (default)
`,
  );
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function gitOut(cwd, args) {
  return gitOutRaw(cwd, args).trim();
}

/**
 * Untrimmed stdout. `git status --porcelain` encodes the unstaged marker as a
 * leading space, so trimming shifts every path in the first line by one.
 *
 * @param {string} cwd
 * @param {string[]} args
 */
function gitOutRaw(cwd, args) {
  const r = git(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

function fail(message, payload = null) {
  process.stderr.write(`${message}\n`);
  if (payload) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(1);
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * Session bookkeeping is not product work: `.forge/` churns on every phase
 * write (including this command's own), so committing it would make every
 * checkpoint dirty the tree again and bury the real diff in scratch.
 */
const EXCLUDE_SCRATCH = ['--', '.', ':(exclude).forge'];

/**
 * Working-tree entries with their porcelain status, including untracked ones —
 * agent work is mostly new files, so a tracked-only view would miss most of it.
 *
 * @param {string} cwd
 * @returns {{ path: string, status: string, untracked: boolean }[]}
 */
export function pendingEntries(cwd) {
  const porcelain = gitOutRaw(cwd, [
    'status',
    '--porcelain',
    '--untracked-files=all',
    ...EXCLUDE_SCRATCH,
  ]);
  if (!porcelain) return [];
  return porcelain
    .split('\n')
    .filter((line) => line.length > 3)
    .map((line) => {
      const status = line.slice(0, 2);
      let file = line.slice(3);
      // Renames read `old -> new`; the new path is what landed.
      if (file.includes(' -> ')) file = file.split(' -> ')[1];
      return { path: file.replace(/^"|"$/g, '').trim(), status, untracked: status === '??' };
    })
    .filter((e) => e.path)
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * @param {string} cwd
 * @returns {string[]}
 */
export function pendingFiles(cwd) {
  return pendingEntries(cwd).map((e) => e.path);
}

/**
 * What a reviewer should actually read.
 *
 * A group review runs *before* that group's checkpoint, so HEAD is still the
 * previous checkpoint and `<base>..HEAD` is empty — the reviewer would be
 * handed a range containing nothing. While the tree is dirty the target is the
 * working tree instead, and untracked files are named because `git diff` never
 * shows them.
 *
 * @param {string} base
 * @param {{ path: string, untracked: boolean }[]} pending
 * @returns {string}
 */
export function reviewTargetFor(base, pending) {
  if (pending.length === 0) return `${base}..HEAD`;
  const untracked = pending.filter((e) => e.untracked).map((e) => e.path);
  const target = `git diff ${base} (working tree vs the last checkpoint)`;
  if (untracked.length === 0) return target;
  return `${target} — plus ${untracked.length} untracked file(s) that no diff shows, read them in full: ${untracked.join(', ')}`;
}

/**
 * Git operations that must finish before anything else touches the index.
 * @param {string} cwd
 */
function inProgressOperation(cwd) {
  const gitDir = path.join(cwd, '.git');
  for (const [file, label] of [
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['BISECT_LOG', 'bisect'],
  ]) {
    if (fs.existsSync(path.join(gitDir, file))) return label;
  }
  return null;
}

/**
 * @param {{ slug?: string, openspecChange?: string }} session
 * @param {{ group?: string, tasks?: string, message?: string }} opts
 */
export function checkpointSubject(session, opts) {
  if (opts.message) return opts.message;
  const scope = session.openspecChange || session.slug || 'session';
  const label = [opts.group, opts.tasks && `tasks ${opts.tasks}`].filter(Boolean).join(' ');
  return `forge(${scope}): checkpoint${label ? ` — ${label}` : ''}`;
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(0);
}

/** @type {{ group?: string, tasks?: string, message?: string }} */
const opts = {};
let dryRun = false;
let rangeOnly = false;
let sinceLast = false;
let allowDefaultBranch = false;
let sessionId = null;
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--group' && args[i + 1]) opts.group = args[(i += 1)];
  else if (a === '--tasks' && args[i + 1]) opts.tasks = args[(i += 1)];
  else if ((a === '--message' || a === '-m') && args[i + 1]) opts.message = args[(i += 1)];
  else if (a === '--session' && args[i + 1]) sessionId = args[(i += 1)];
  else if (a === '--dry-run') dryRun = true;
  else if (a === '--range') rangeOnly = true;
  else if (a === '--last') sinceLast = true;
  else if (a === '--allow-default-branch') allowDefaultBranch = true;
  else {
    usage();
    fail(`Unknown argument: ${a}`);
  }
}

const cwd = REPO_ROOT;

// Strict: a checkpoint makes a git commit. Committing one session's work under
// another's name is not undone by re-running.
// Strict only when it commits. `--dry-run` reports what would be committed and
// `--range` prints a diff range for a reviewer brief; neither writes anything,
// so refusing there is an obstruction with no damage behind it. Keyed on both,
// because the first version keyed on `dryRun` alone and left the bare
// `forge checkpoint --range --last` in `implement.md` refusing.
sessionId = resolveSessionOrExit(sessionId, {
  command: 'forge checkpoint',
  strict: !dryRun && !rangeOnly,
});
const { dir: sessionDir, session } = loadSession(sessionId);

const checkpoints = Array.isArray(session.checkpoints) ? session.checkpoints : [];

// --- `--range`: what a reviewer should read, no repo mutation ---
if (rangeOnly) {
  const base = sinceLast && checkpoints.length ? checkpoints[checkpoints.length - 1].sha : session.baseCommit;
  if (!base) {
    emit({
      ok: false,
      range: null,
      base: null,
      checkpoints: checkpoints.length,
      note: 'No base commit recorded — this session started before checkpoints, so reviewers read the working tree (git diff).',
    });
    process.exit(1);
  }
  let pending = [];
  try {
    pending = pendingEntries(cwd);
  } catch {
    /* not a git repo / unreadable — fall back to the bare commit range */
  }
  emit({
    ok: true,
    base,
    range: `${base}..HEAD`,
    dirty: pending.length > 0,
    pending: pending.map((e) => e.path),
    untracked: pending.filter((e) => e.untracked).map((e) => e.path),
    reviewTarget: reviewTargetFor(base, pending),
    checkpoints: checkpoints.length,
    note: 'Pass reviewTarget as {DIFF_RANGE}. `range` is the commit range only — it is empty while the group under review is still uncommitted.',
  });
  process.exit(0);
}

// --- gates ---
const config = loadProjectConfig(cwd);
const mode = config?.git?.checkpoint ?? 'off';
if (!MODES.includes(mode)) {
  fail(`Unknown git.checkpoint mode "${mode}" in .forge/config.json (expected ${MODES.join(' | ')}).`);
}
if (mode === 'off') {
  fail(
    'Checkpoints are off for this project. Enable with .forge/config.json → { "git": { "checkpoint": "per-group" } }.',
    { ok: false, reason: 'git.checkpoint is "off" — checkpoints disabled for this project' },
  );
}

if (!fs.existsSync(path.join(cwd, '.git'))) {
  fail(`Not a git repository: ${cwd} — nothing to checkpoint.`, { ok: false, reason: 'not a git repo' });
}

const busy = inProgressOperation(cwd);
if (busy) {
  fail(`A ${busy} is in progress — finish it before checkpointing.`, { ok: false, reason: `${busy} in progress` });
}

let branch;
try {
  branch = gitOut(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
} catch (err) {
  fail(`Could not read the current branch: ${err instanceof Error ? err.message : err}`);
}
if (DEFAULT_BRANCHES.has(branch) && !allowDefaultBranch && config?.git?.allowDefaultBranch !== true) {
  fail(
    `Refusing to checkpoint on the default branch "${branch}". Forge work belongs on a branch — create one, or pass --allow-default-branch (or set git.allowDefaultBranch: true) if this project really commits to ${branch}.`,
    { ok: false, reason: `default branch "${branch}"` },
  );
}

// --- what would land ---
let files;
try {
  files = pendingFiles(cwd);
} catch (err) {
  fail(`Could not read the working tree: ${err instanceof Error ? err.message : err}`);
}

const subject = checkpointSubject(session, opts);

if (files.length === 0) {
  emit({
    ok: true,
    committed: false,
    reason: 'nothing to checkpoint — working tree is clean',
    branch,
    range: session.baseCommit ? `${session.baseCommit}..HEAD` : null,
  });
  process.exit(0);
}

if (dryRun) {
  emit({ ok: true, committed: false, dryRun: true, branch, subject, files });
  process.exit(0);
}

// --- commit (never push) ---
const prev = checkpoints.length ? checkpoints[checkpoints.length - 1].sha : null;
try {
  gitOut(cwd, ['add', '-A', ...EXCLUDE_SCRATCH]);
} catch (err) {
  fail(`git add failed: ${err instanceof Error ? err.message : err}`);
}
const commit = git(cwd, ['commit', '-m', subject, '--no-verify']);
if (commit.status !== 0) {
  fail(`git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`);
}
const sha = gitOut(cwd, ['rev-parse', 'HEAD']);

// A session created before checkpoints existed has no base; this commit's
// parent is the closest honest answer.
if (!session.baseCommit) {
  try {
    session.baseCommit = gitOut(cwd, ['rev-parse', `${sha}^`]);
  } catch {
    session.baseCommit = sha; // root commit — nothing before it
  }
}
if (!session.branch) session.branch = branch;

checkpoints.push({
  sha,
  subject,
  group: opts.group ?? null,
  tasks: opts.tasks ?? null,
  files: files.length,
  at: new Date().toISOString(),
});
session.checkpoints = checkpoints;
saveSession(sessionDir, session);

emit({
  ok: true,
  committed: true,
  sha,
  subject,
  branch,
  files,
  range: `${session.baseCommit}..HEAD`,
  groupRange: prev ? `${prev}..${sha}` : `${session.baseCommit}..${sha}`,
  pushed: false,
  note: 'Checkpoints never push. Pass groupRange as {DIFF_RANGE} to the group reviewer.',
});
