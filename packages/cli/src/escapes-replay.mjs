/**
 * Replay verification for Escape candidates (CONTEXT.md): run the test a fix
 * commit added, twice, in throwaway git worktrees — on the fix's parent with the
 * fix's version of the test copied in, and on the fix itself. A test that fails
 * before and passes after is the proof an Escape was real.
 *
 * Replay rules are recorded in `.forge/config.json`, not detected (ADR-0001):
 * `escapes.replay` is an ordered `[{ match, cwd, command }]`.
 *
 * The operator's working tree is never touched: only `.git` gains and loses
 * worktree metadata. `node_modules` is linked into each worktree from the
 * operator's copy, and every link is removed before its worktree is.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { decide, isFixCommit, tagCandidate } from './escapes.mjs';
import { CALLER_EXEC_SPAWN } from './exec-gate.mjs';
import { globToRegExp } from './guard.mjs';

export const DEFAULT_REPLAY_TIMEOUT_SEC = 300;

/**
 * An old run that fails like this failed because the test needs code or
 * packages the fix brought, not because of the bug — so it proves nothing.
 */
export const ENVIRONMENT_SIGNATURES = new RegExp(
  [
    // node
    'Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|does not provide an export|SyntaxError',
    // a missing file or binary, and a helper the fix added being called
    'ENOENT|is not a function',
    // python
    'ModuleNotFoundError|ImportError',
    // vitest / vite, esbuild
    'Failed to resolve import|Could not resolve',
    // go — `undefined:` only in Go's own `<file>.go:<line>:<col>:` shape, so JS text like "expected undefined: 5" stays a failure
    '\\.go:\\d+:\\d+: undefined: \\w|cannot find package|no required module provides package',
    // typescript
    '\\bTS(?:2304|2307|2339|2554)\\b',
    // rust
    'error\\[E0432\\]',
    // java
    'cannot find symbol',
    // ruby
    'LoadError',
  ].join('|'),
);

/** Windows reports a crashed process as an NTSTATUS exit code (0xC0000005 = access violation), not `null`. */
const FIRST_NTSTATUS_EXIT = 0xc0000000;

/** Output kept per run, from the end — a failing test prints its reason last. */
const OUTPUT_KEEP = 1024 * 1024;

/** @param {string} p */
const posix = (p) => String(p).replace(/\\/g, '/');

/**
 * The replay rule for a test: the first `escapes.replay` entry whose `match`
 * glob hits the project-root-relative `testPath`. A rule without a `match`, or
 * with no `{file}` in its `command`, can't run anything and is skipped.
 *
 * @param {unknown} config project config (`.forge/config.json`)
 * @param {string} testPath project-root-relative, posix
 * @returns {{ match: string, cwd: string, command: string } | null}
 */
/**
 * A rule's `copy` list: gitignored files a test needs (e.g. `.env`) that a fresh worktree lacks.
 * Only relative paths that stay inside the rule's `cwd` are kept — never absolute, never `..`.
 *
 * @param {unknown} list
 * @returns {string[]}
 */
function safeCopyList(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((p) => {
    if (typeof p !== 'string' || p === '') return false;
    if (/^[A-Za-z]:|^[\\/]/.test(p)) return false;
    const norm = path.posix.normalize(posix(p));
    return norm !== '..' && !norm.startsWith('../') && norm !== '.';
  });
}

/**
 * Copy the rule's `copy` files from the operator's working copy into a worktree, at the same
 * paths under the rule's cwd. A file missing from the working copy is skipped.
 *
 * @param {{ from: string, to: string, files: string[] }} o
 */
function copyIgnored({ from, to, files }) {
  for (const rel of files) {
    const src = path.join(from, rel);
    let st;
    try {
      st = fs.statSync(src);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const dest = path.join(to, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

export function resolveReplayRule(config, testPath) {
  const rules = /** @type {any} */ (config)?.escapes?.replay;
  if (!Array.isArray(rules)) return null;
  const target = posix(testPath);
  for (const r of rules) {
    if (!r || typeof r.match !== 'string' || typeof r.command !== 'string' || !r.command.includes('{file}')) continue;
    if (r.cwd != null && typeof r.cwd !== 'string') continue;
    if (globToRegExp(posix(r.match)).test(target)) return { match: r.match, cwd: posix(r.cwd ?? '.'), command: r.command, copy: safeCopyList(r.copy) };
  }
  return null;
}

/**
 * Split a command line into argv — whitespace separates, single or double
 * quotes group. No shell: nothing is expanded.
 *
 * @param {string} command
 * @returns {string[]}
 */
export function splitArgv(command) {
  /** @type {string[]} */
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (has || cur) out.push(cur);
  return out;
}

/**
 * The argv a replay runs: the rule's command split without a shell, `{file}`
 * replaced by the test's path relative to the rule's `cwd`.
 *
 * @param {{ repo: string, testPath: string, rule: { cwd?: string, command: string } }} o `testPath` is relative to `repo`
 * @returns {string[]}
 */
export function replayArgv({ repo, testPath, rule }) {
  const rootRelTest = repo === '.' ? posix(testPath) : `${posix(repo)}/${posix(testPath)}`;
  const file = path.posix.relative(path.posix.normalize(posix(rule.cwd ?? '.')), rootRelTest);
  return splitArgv(rule.command).map((t) => t.replaceAll('{file}', file));
}

/** @param {string} cwd @param {string[]} args */
const git = (cwd, args) => spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, maxBuffer: 256 * 1024 * 1024 });

/** @param {import('node:child_process').ChildProcess} child */
function killTree(child) {
  if (child.pid == null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

/**
 * @param {string[]} argv
 * @param {string} cwd
 * @param {number} timeoutSec
 * @returns {Promise<{ exit: number | null, output: string, timedOut: boolean, error: string | null }>}
 *   `error` is the spawn error when the command could not start
 */
function run(argv, cwd, timeoutSec) {
  const env = { ...process.env };
  // A replay run from inside `node --test` must behave as a fresh top-level run.
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let done = false;
    /** @type {string | null} */
    let error = null;
    /** @type {NodeJS.Timeout | undefined} */
    let hardStop;
    const finish = (/** @type {number | null} */ exit) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(hardStop);
      resolve({ exit, output, timedOut, error });
    };
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      ...CALLER_EXEC_SPAWN,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const collect = (/** @type {Buffer} */ d) => {
      output = (output + d.toString('utf8')).slice(-OUTPUT_KEEP);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (err) => {
      output += `${err.message}\n`;
      error = err.message;
      finish(null);
    });
    child.on('close', (code) => finish(timedOut ? null : code));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      hardStop = setTimeout(() => finish(null), 5000);
    }, timeoutSec * 1000);
  });
}

/** Remove a directory link without touching its target. @param {string} link */
function removeLink(link) {
  let st;
  try {
    st = fs.lstatSync(link);
  } catch {
    return;
  }
  if (!st.isSymbolicLink()) return;
  try {
    fs.unlinkSync(link);
  } catch {
    fs.rmdirSync(link);
  }
}

/**
 * Where replay worktrees live: `<project's parent>/forge-replay-<project>/`, self-ignored. Each
 * other place broke a real runner on Volo: the OS temp dir on another drive (Vite/esbuild walked
 * into an unreadable parent and could not load its config), inside `.git` (Vite's default
 * `server.fs.deny`), and any path with a dot segment such as `.forge/replay` (Jest on Windows reads
 * `\.forge` in its rootDir-based testMatch glob as an escaped dot and finds no tests).
 * Returns the directories this call created, so cleanup can remove them again when empty.
 *
 * ponytail: one sibling dir per project; a read-only parent is not handled.
 *
 * @param {string} projectRoot
 * @returns {{ base: string, created: string[] }}
 */
function replayBase(projectRoot) {
  const root = path.resolve(projectRoot);
  const base = path.join(path.dirname(root), `forge-replay-${path.basename(root)}`);
  const created = fs.existsSync(base) ? [] : [base];
  fs.mkdirSync(base, { recursive: true });
  const ignore = path.join(base, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  return { base, created };
}

/** Remove what `replayBase` created, deepest first, only when nothing else is left in it. */
function dropReplayBase({ base, created }) {
  if (!created.includes(base)) return;
  try {
    // Only when nothing but our .gitignore is left (another run may still own a worktree here).
    if (fs.readdirSync(base).every((n) => n === '.gitignore')) fs.rmSync(base, { recursive: true, force: true });
  } catch {
    // already gone — nothing to do
  }
}

/**
 * One throwaway worktree at `rev`: `prepare` may write into it, `node_modules`
 * is linked at `within`, `fn` runs, and the link and the worktree are removed.
 *
 * @template T
 * @param {{ repoDir: string, rev: string, within: string, baseDir: string, prepare?: (dir: string) => void, fn: (dir: string) => Promise<T> }} o
 * @returns {Promise<T>}
 */
async function inWorktree({ repoDir, rev, within, baseDir, prepare, fn }) {
  const dir = fs.mkdtempSync(path.join(baseDir, 'r-'));
  const link = path.join(dir, within, 'node_modules');
  let added = false;
  try {
    const add = git(repoDir, ['worktree', 'add', '--detach', dir, rev]);
    if (add.status !== 0) throw new Error(`git worktree add ${rev.slice(0, 12)} failed: ${add.stderr}`);
    added = true;
    prepare?.(dir);
    const source = path.join(repoDir, within, 'node_modules');
    if (fs.existsSync(source) && fs.existsSync(path.dirname(link)) && !fs.existsSync(link)) fs.symlinkSync(source, link, 'junction');
    return await fn(path.join(dir, within));
  } finally {
    removeLink(link);
    if (added) git(repoDir, ['worktree', 'remove', '--force', dir]);
    // Only after the link is gone — never recurse through it.
    if (!fs.existsSync(link)) fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run the replay test on the fix's parent (with the fix's version of the test
 * copied in) and on the fix. When the old run times out the fix run is skipped
 * (`exit: null`) — the candidate is undecided either way.
 *
 * @param {{ projectRoot: string, repo: string, fixSha: string, testPath: string,
 *   rule: { cwd?: string, command: string, copy?: string[] }, timeoutSec?: number }} opts
 *   `repo` is `"."` or the nested repository path; `testPath` is relative to that repository;
 *   `rule.cwd` is relative to the project root.
 * @returns {Promise<{ old: { exit: number | null, output: string, timedOut: boolean },
 *   fix: { exit: number | null, output: string, timedOut: boolean } }>}
 */
export async function runReplay({ projectRoot, repo, fixSha, testPath, rule, timeoutSec = DEFAULT_REPLAY_TIMEOUT_SEC }) {
  const repoDir = repo === '.' ? path.resolve(projectRoot) : path.join(path.resolve(projectRoot), repo);
  const repoRelTest = posix(testPath);
  const ruleCwd = path.posix.normalize(posix(rule.cwd ?? '.'));
  const within = repo === '.' ? ruleCwd : path.posix.relative(posix(repo), ruleCwd);
  if (within === '..' || within.startsWith('../') || path.posix.isAbsolute(within)) {
    throw new Error(`replay rule cwd "${rule.cwd}" is outside the repository "${repo}"`);
  }
  const argv = replayArgv({ repo, testPath, rule });
  if (argv.length === 0) throw new Error('replay rule has an empty command');

  git(repoDir, ['worktree', 'prune']);
  const testBody = git(repoDir, ['show', `${fixSha}:${repoRelTest}`]);
  if (testBody.status !== 0) throw new Error(`${repoRelTest} is not in ${fixSha.slice(0, 7)}`);
  if (git(repoDir, ['rev-parse', '--verify', '--quiet', `${fixSha}^`]).status !== 0) {
    throw new Error(`${fixSha.slice(0, 7)} has no parent to replay against`);
  }

  const where = replayBase(projectRoot);
  try {
    const old = await inWorktree({
      repoDir,
      rev: `${fixSha}^`,
      within,
      baseDir: where.base,
      prepare: (dir) => {
        const dest = path.join(dir, repoRelTest);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, testBody.stdout);
        copyIgnored({ from: path.join(repoDir, within), to: path.join(dir, within), files: rule.copy ?? [] });
      },
      fn: (cwd) => run(argv, cwd, timeoutSec),
    });
    if (old.timedOut) return { old, fix: { exit: null, output: '', timedOut: false, error: null } };
    const fix = await inWorktree({
      repoDir,
      rev: fixSha,
      within,
      baseDir: where.base,
      prepare: (dir) => copyIgnored({ from: path.join(repoDir, within), to: path.join(dir, within), files: rule.copy ?? [] }),
      fn: (cwd) => run(argv, cwd, timeoutSec),
    });
    return { old, fix };
  } finally {
    dropReplayBase(where);
  }
}

/**
 * What a replay shows. Never dismisses: only `confirmed` is a verdict.
 *
 * @param {{ old: { exit: number | null, output: string, timedOut: boolean, error?: string | null },
 *   fix: { exit: number | null, output: string, timedOut: boolean, error?: string | null } }} runs
 * @returns {{ outcome: 'confirmed' | 'environment' | 'not-reproduced' } | { outcome: 'undecided', reason: string }}
 *   an undecided reason is `timeout`, `no-exit` (the old run crashed or was killed) or `cannot-start: <error>`
 */
export function classifyReplay({ old, fix }) {
  if (old.timedOut || fix.timedOut) return { outcome: 'undecided', reason: 'timeout' };
  if (old.error && fix.error) return { outcome: 'undecided', reason: `cannot-start: ${old.error}` };
  if (fix.exit !== 0) return { outcome: 'environment' };
  if (old.exit === null || old.exit >= FIRST_NTSTATUS_EXIT) return { outcome: 'undecided', reason: 'no-exit' };
  if (old.exit === 0) return { outcome: 'not-reproduced' };
  return { outcome: ENVIRONMENT_SIGNATURES.test(old.output) ? 'environment' : 'confirmed' };
}

/**
 * Classify a replay and record it: a proof becomes an auto-confirmed decision in
 * the escape ledger; anything else becomes a tag and the candidate stays pending.
 *
 * @param {{ cwd: string, sessionId: string, slug?: string | null,
 *   candidate: { commit: string, repo?: string, inferred?: string | null }, testPath: string, command: string,
 *   old: { exit: number | null, output: string, timedOut: boolean, error?: string | null },
 *   fix: { exit: number | null, output: string, timedOut: boolean, error?: string | null } }} opts
 * @returns {{ outcome: string, reason: string | null }}
 */
export function recordReplay({ cwd, sessionId, slug = null, candidate, testPath, command, old, fix }) {
  const verdict = classifyReplay({ old, fix });
  const repo = candidate.repo ?? '.';
  const exits = { command, oldExit: old.exit, fixExit: fix.exit };
  let { outcome } = verdict;
  let reason = 'reason' in verdict ? verdict.reason : null;
  // Only a fix or revert can be an Escape; `verify` filters first, this keeps any other caller honest.
  if (outcome === 'confirmed' && !isFixCommit(candidate.subject)) outcome = 'not-a-fix';
  if (outcome === 'confirmed') {
    const res = decide({
      cwd,
      sessionId,
      slug,
      commit: candidate.commit,
      decision: 'confirmed',
      replayTest: testPath,
      repo,
      inferred: candidate.inferred ?? null,
      auto: true,
      ...exits,
    });
    if (res.ok) return { outcome, reason: null };
    outcome = 'undecided';
    reason = res.error;
  }
  tagCandidate({ cwd, sessionId, commit: candidate.commit, repo, tag: outcome, reason, ...exits });
  return { outcome, reason };
}
