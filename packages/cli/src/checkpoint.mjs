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
 * Staging uses `git add -A` excluding `.forge/` scratch — but refuses first
 * when untracked paths sit under a *foreign* plan-engine change directory
 * (`<plan.dir>/changes/<other>/`, not this session's openspecChange, not
 * `archive/`), so another change's in-progress files are never swept in.
 *
 * Usage:
 *   forge checkpoint --group <name> [--tasks <ids>] [--message <subject>]
 *   forge checkpoint --dry-run
 *   forge checkpoint --range [--last]
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadSession, resolveSessionOrExit, REPO_ROOT, saveSession, unfinishedSessions } from './lib.mjs';
import { loadProjectConfig } from './config.mjs';
import { resolveProjectPlanEngine } from './plan-engine.mjs';

const MODES = ['off', 'per-group', 'per-task'];
const DEFAULT_BRANCHES = new Set(['main', 'master']);

function usage() {
  process.stderr.write(
    `Usage:
  forge checkpoint --group <name> [--tasks <ids>] [--message <subject>]
  forge checkpoint --path <p> [--path <p> ...]  scope staging to these paths
                                             (only consulted while another
                                             session's change dir is open)
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
 * Foreign untracked change dirs are a separate gate — see
 * `foreignUntrackedChangePaths` — not an add-pathspec exclude.
 */
const EXCLUDE_SCRATCH = ['--', '.', ':(exclude).forge'];

/**
 * Untracked paths under `<planDir>/changes/<segment>/…` where `segment` is
 * neither the session's openspecChange nor `archive`. With no openspecChange,
 * every non-archive segment is foreign.
 *
 * @param {{ path: string, untracked: boolean }[]} pending
 * @param {string} planDir
 * @param {string | null | undefined} openspecChange
 * @returns {string[]}
 */
export function foreignUntrackedChangePaths(pending, planDir, openspecChange) {
  const root = String(planDir || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  if (!root) return [];
  const prefix = `${root}/changes/`;
  const allowed = new Set(['archive']);
  if (openspecChange) allowed.add(openspecChange);
  return pending
    .filter((e) => e.untracked)
    .map((e) => e.path.replace(/\\/g, '/'))
    .filter((p) => {
      if (!p.startsWith(prefix)) return false;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash <= 0) return false;
      const segment = rest.slice(0, slash);
      return Boolean(segment) && !allowed.has(segment);
    })
    .sort((a, b) => a.localeCompare(b));
}

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
 * Change directories of every *other* open session sharing this project.
 * "Open" mirrors `unfinishedSessions`: phase not `done`/`skipped`, and a
 * malformed/unreadable `session.json` is skipped rather than fatal — it
 * cannot prove an overlap, and a crash here would block an honest checkpoint.
 * A session is kept only when it is not `thisSessionId` and its
 * `openspecChange` resolves to a directory that exists on disk.
 *
 * Pure: takes `sessionsDir` and `planDir` as arguments rather than reading
 * `SESSIONS_DIR` or `process.cwd()`, so a caller (or a test) can point it at
 * a throwaway fixture.
 *
 * @param {string} sessionsDir
 * @param {string} thisSessionId
 * @param {string} planDir
 * @returns {string[]}
 */
export function otherOpenChangeDirs(sessionsDir, thisSessionId, planDir) {
  const sessions = unfinishedSessions(sessionsDir) || [];
  const dirs = [];
  for (const s of sessions) {
    if (s.unreadable) continue; // couldn't parse it — not proof of overlap
    if (s.id === thisSessionId) continue;
    let openspecChange;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(sessionsDir, s.id, 'session.json'), 'utf8'));
      openspecChange = raw?.openspecChange;
    } catch {
      continue; // malformed/unreadable — skip, not fatal
    }
    if (!openspecChange) continue;
    const dir = path.join(planDir, 'changes', openspecChange);
    if (fs.existsSync(dir)) dirs.push(dir);
  }
  return dirs;
}

/**
 * True when `entryPath` is `dirPath` itself or nested under it —
 * segment-aware, so `src/foo` never matches `src/foobar`. Same discipline
 * `foreignUntrackedChangePaths` uses for its prefix check (normalize
 * separators, strip a trailing slash, require the boundary `/`), generalized
 * to a whole directory rather than one path segment after a fixed prefix.
 *
 * @param {string} entryPath
 * @param {string} dirPath
 * @returns {boolean}
 */
function isUnderDir(entryPath, dirPath) {
  const dir = String(dirPath || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  if (!dir) return false;
  const p = String(entryPath || '').replace(/\\/g, '/');
  return p === dir || p.startsWith(`${dir}/`);
}

/**
 * Partitions pending working-tree entries into `mine` (under this session's
 * own change dir), `foreignPlan` (under one of `otherDirs`, i.e. an other-open
 * session's change dir — see `otherOpenChangeDirs`), and `shared` (everything
 * else: source files, docs, or a change dir with no open session behind it).
 * Pure and order-preserving; matching is segment-aware via `isUnderDir`.
 *
 * @param {{ path: string }[]} pending
 * @param {string} mineDir
 * @param {string[]} otherDirs
 * @returns {{ mine: string[], foreignPlan: string[], shared: string[] }}
 */
export function classifyPendingEntries(pending, mineDir, otherDirs) {
  const mine = [];
  const foreignPlan = [];
  const shared = [];
  for (const e of pending) {
    if (isUnderDir(e.path, mineDir)) mine.push(e.path);
    else if (otherDirs.some((dir) => isUnderDir(e.path, dir))) foreignPlan.push(e.path);
    else shared.push(e.path);
  }
  return { mine, foreignPlan, shared };
}

/**
 * Repo-relative, forward-slash path for a `--path` argument, resolved against
 * `cwd` the same way a pathspec typed on the command line is.
 *
 * @param {string} cwd
 * @param {string} raw
 * @returns {string}
 */
function toRepoRelative(cwd, raw) {
  return path.relative(cwd, path.resolve(cwd, raw)).replace(/\\/g, '/');
}

/**
 * Same enumeration `otherOpenChangeDirs` does, kept as a separate function so
 * that group-1's pure helper stays untouched — this one also remembers which
 * session owns each dir, needed only to name a session in a refusal message.
 *
 * @param {string} sessionsDir
 * @param {string} thisSessionId
 * @param {string} planDir
 * @returns {Map<string, string>} change dir -> owning session id
 */
function otherOpenChangeDirOwners(sessionsDir, thisSessionId, planDir) {
  const sessions = unfinishedSessions(sessionsDir) || [];
  const owners = new Map();
  for (const s of sessions) {
    if (s.unreadable) continue;
    if (s.id === thisSessionId) continue;
    let openspecChange;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(sessionsDir, s.id, 'session.json'), 'utf8'));
      openspecChange = raw?.openspecChange;
    } catch {
      continue;
    }
    if (!openspecChange) continue;
    const dir = path.join(planDir, 'changes', openspecChange);
    if (fs.existsSync(dir)) owners.set(dir, s.id);
  }
  return owners;
}

/**
 * The session owning the change dir `entryPath` sits under (an entry of
 * `otherOpenChangeDirOwners`'s keys), or `null` if none matches.
 *
 * @param {string} entryPath
 * @param {Map<string, string>} owners
 * @returns {string | null}
 */
function ownerForPath(entryPath, owners) {
  for (const [dir, id] of owners) {
    if (isUnderDir(entryPath, dir)) return id;
  }
  return null;
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

// Guards the executable body below so importing this module for its pure
// exports (`otherOpenChangeDirs`, `classifyPendingEntries`, …) never runs the
// CLI as a side effect of `import` — same pattern as doctor.mjs / exit-check.mjs.
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  runCli();
}

function runCli() {
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(0);
}

/** @type {{ group?: string, tasks?: string, message?: string, paths?: string[] }} */
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
  else if (a === '--path' && args[i + 1]) (opts.paths ?? (opts.paths = [])).push(args[(i += 1)]);
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
let pending;
try {
  pending = pendingEntries(cwd);
} catch (err) {
  fail(`Could not read the working tree: ${err instanceof Error ? err.message : err}`);
}
const files = pending.map((e) => e.path);

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

const planDir = resolveProjectPlanEngine(cwd).dir;
const sessionsDir = path.dirname(sessionDir);
const otherOpen = otherOpenChangeDirs(sessionsDir, sessionId, planDir);

/** @type {string[]} */
let stagedFiles;

if (otherOpen.length === 0) {
  // --- single-session path: unchanged (F72 backstop) ---
  const foreign = foreignUntrackedChangePaths(pending, planDir, session.openspecChange);
  if (foreign.length > 0) {
    const changeLabel = session.openspecChange || '(none)';
    fail(
      `Refusing to checkpoint: untracked path(s) under a foreign change directory ` +
        `(session change: ${changeLabel}):\n${foreign.map((p) => `  ${p}`).join('\n')}`,
      {
        ok: false,
        reason: 'foreign untracked change paths',
        foreign,
        openspecChange: session.openspecChange ?? null,
        planDir,
      },
    );
  }
  try {
    gitOut(cwd, ['add', '-A', ...EXCLUDE_SCRATCH]);
  } catch (err) {
    fail(`git add failed: ${err instanceof Error ? err.message : err}`);
  }
  stagedFiles = files;
} else {
  // --- another session is open: refuse or scope, never sweep its work in
  // (F111) — `git add -A` is never used once there is overlap.
  const mineDir = session.openspecChange ? path.join(planDir, 'changes', session.openspecChange) : '';
  const { mine, foreignPlan, shared } = classifyPendingEntries(pending, mineDir, otherOpen);
  const owners = otherOpenChangeDirOwners(sessionsDir, sessionId, planDir);

  if (opts.paths && opts.paths.length > 0) {
    const resolvedPaths = opts.paths.map((p) => toRepoRelative(cwd, p));
    for (const rel of resolvedPaths) {
      const badDir = otherOpen.find((dir) => isUnderDir(rel, dir));
      if (badDir) {
        fail(
          `Refusing to checkpoint: --path ${rel} resolves under another open session's change ` +
            `directory (${badDir}, session ${owners.get(badDir) ?? 'unknown'}). ` +
            `You cannot checkpoint another open session's plan, even explicitly.`,
          {
            ok: false,
            reason: 'path under foreign change dir',
            path: rel,
            foreignDir: badDir,
            session: owners.get(badDir) ?? null,
          },
        );
      }
    }
    const scoped = pending.filter(
      (e) => isUnderDir(e.path, mineDir) || resolvedPaths.some((rel) => isUnderDir(e.path, rel)),
    );
    stagedFiles = scoped.map((e) => e.path);
    try {
      if (stagedFiles.length > 0) gitOut(cwd, ['add', '--', ...stagedFiles]);
    } catch (err) {
      fail(`git add failed: ${err instanceof Error ? err.message : err}`);
    }
  } else {
    if (foreignPlan.length > 0 || shared.length > 0) {
      const lines = [
        ...foreignPlan.map((p) => `  ${p}  (owned by session ${ownerForPath(p, owners) ?? 'unknown'})`),
        ...shared.map((p) => `  ${p}`),
      ];
      fail(
        `Refusing to checkpoint: another session is open and pending change(s) fall outside this ` +
          `session's scope:\n${lines.join('\n')}\n` +
          `Scope with --path, or finish/pause the other session(s).`,
        {
          ok: false,
          reason: 'pending changes outside session scope',
          foreignPlan,
          shared,
          otherOpen,
        },
      );
    }
    stagedFiles = mine;
    try {
      if (stagedFiles.length > 0) gitOut(cwd, ['add', '--', ...stagedFiles]);
    } catch (err) {
      fail(`git add failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

// --- commit (never push) ---
const prev = checkpoints.length ? checkpoints[checkpoints.length - 1].sha : null;
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
  files: stagedFiles.length,
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
  files: stagedFiles,
  range: `${session.baseCommit}..HEAD`,
  groupRange: prev ? `${prev}..${sha}` : `${session.baseCommit}..${sha}`,
  pushed: false,
  note: 'Checkpoints never push. Pass groupRange as {DIFF_RANGE} to the group reviewer.',
});
}
