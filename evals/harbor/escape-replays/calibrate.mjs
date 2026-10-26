/**
 * Reference build and calibration for one escape-replay candidate (specs/changes/escape-replays).
 *
 * Three throwaway worktrees of the session's nested repository, next to the project like every
 * replay (`forge-replay-<project>`): the base and the escaped head, where each hidden test must
 * fail, and the head with the fix commits cherry-picked on top, where each must pass. The last
 * one is also what the reference patch is cut from, from git objects only, never from the
 * worktree's files. Test files in the hidden tests' folders that pass on both base and reference,
 * and are the same blob in both, become the regression set.
 *
 * The operator's checkout is never touched: only `.git` gains and loses worktree metadata.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  DEFAULT_REPLAY_TIMEOUT_SEC,
  ENVIRONMENT_SIGNATURES,
  copyIgnored,
  dropReplayBase,
  inWorktree,
  removeLink,
  replayArgv,
  replayBase,
  resolveReplayRule,
  run,
} from '../../../packages/cli/src/escapes-replay.mjs';
import { LOCKFILES, folderAndAncestors, isProtectedName, isRcName } from './deps.mjs';
import { judge } from './outcome.mjs';

/**
 * ponytail: at most this many regression files per task. The verifier runs each once, and a
 * folder of hundreds of tests would make a grade slower than the agent's own work.
 */
export const REGRESSION_CAP = 20;

/** A file name that looks like a test: `x.test.js`, `x.spec.ts`, `x_test.go`, `test_x.py`, `x-test.js`. */
const TEST_FILE = /(?:[._-](?:test|spec)\.[A-Za-z0-9]+|_test\.[A-Za-z0-9]+|^test_.+\.py)$/;

const posix = (/** @type {string} */ p) => String(p).replace(/\\/g, '/');

/**
 * @param {string} cwd @param {string[]} args @param {{ lf?: boolean, input?: Buffer | string }} [o]
 * `lf` forces LF whatever the host's autocrlf says: for anything that becomes a patch.
 */
function git(cwd, args, { lf = false, input, env } = {}) {
  const config = lf ? ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf'] : [];
  const r = spawnSync('git', ['-c', 'core.quotePath=false', ...config, ...args], { cwd, input, env: env ? { ...process.env, ...env } : process.env, maxBuffer: 512 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? Buffer.alloc(0), stderr: String(r.stderr ?? '') };
}

/** @typedef {{ path: string, argv: string[], rule: Record<string, any>, within: string, commit?: string, oid?: string }} TestEntry */

/** The rule's cwd relative to the repository, where the test runs inside a worktree or the snapshot. */
function withinOf(repo, cwd) {
  const norm = path.posix.normalize(posix(cwd ?? '.'));
  const within = repo === '.' ? norm : path.posix.relative(posix(repo), norm);
  return within === '' ? '.' : within;
}

const outsideRepo = (/** @type {string} */ within) => within === '..' || within.startsWith('../') || path.posix.isAbsolute(within);

/** The entries directly inside `dir` of a tree-ish: `{ mode, type, oid, rel }`, `rel` relative to the repository. */
function lsTree(repoDir, rev, dir) {
  const listing = git(repoDir, ['ls-tree', '-z', rev, ...(dir === '.' ? [] : ['--', `${dir}/`])]);
  if (listing.status !== 0) return [];
  return listing.stdout.toString('utf8').split('\0').filter(Boolean).map((entry) => {
    const [meta, rel] = entry.split('\t');
    const [mode, type, oid] = meta.split(' ');
    return { mode, type, oid, rel };
  });
}

function classify(r) {
  if (r.timedOut) return 'timeout';
  if (r.error) return 'cannot-start';
  return ENVIRONMENT_SIGNATURES.test(r.output) ? 'environment' : 'failure';
}

/** A run passes the way the verifier counts it: exit 0 and, where the runner printed a summary, a passing one. */
const passed = (/** @type {{ argv: string[], exit: number | null, output: string, timedOut: boolean, error: string | null }} */ r) =>
  !r.timedOut && !r.error && judge(r).ok;

/** @param {string} root @param {TestEntry[]} tests @param {number} timeoutSec */
async function runTests(root, tests, timeoutSec) {
  const out = [];
  for (const t of tests) out.push({ path: t.path, argv: t.argv, ...(await run(t.argv, path.join(root, t.within), timeoutSec)) });
  return out;
}

const failure = (r) => ({ path: r.path, classification: classify(r), exit: r.exit, output: r.output.slice(-1500) });

/** Write files (path relative to the tree root) into a tree. */
function writeFiles(root, files) {
  for (const f of files) {
    const dest = path.join(root, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.bytes);
  }
}

/**
 * One worktree of the candidate's repository at `rev`, with `files` written and the rules' `copy`
 * files in place, and `node_modules` linked at every cwd the tests need. `fn` gets the repo root.
 *
 * @template T
 * @param {{ task: Record<string, any>, projectRoot: string, rev: string, files: Array<{ path: string, bytes: Buffer }>,
 *   tests: TestEntry[], fn: (root: string) => Promise<T> }} o
 * @returns {Promise<T>}
 */
async function inTree({ task, projectRoot, rev, files, tests, fn }) {
  const withins = [...new Set(tests.map((t) => t.within))];
  const primary = withins[0] ?? '.';
  const where = replayBase(projectRoot);
  try {
    git(task.repoDir, ['worktree', 'prune']);
    return await inWorktree({
      repoDir: task.repoDir,
      rev,
      within: primary,
      baseDir: where.base,
      prepare: (dir) => {
        writeFiles(dir, files);
        for (const t of tests) copyIgnored({ from: path.join(task.repoDir, t.within), to: path.join(dir, t.within), files: t.rule.copy ?? [] });
      },
      fn: async (cwd) => {
        const root = primary === '.' ? cwd : path.resolve(cwd, ...primary.split('/').map(() => '..'));
        // inWorktree links the first cwd; the others are linked here and unlinked before it removes the tree.
        /** @type {string[]} */
        const links = [];
        try {
          for (const within of withins.slice(1)) {
            const source = path.join(task.repoDir, within, 'node_modules');
            const link = path.join(root, within, 'node_modules');
            if (fs.existsSync(source) && fs.existsSync(path.dirname(link)) && !fs.existsSync(link)) {
              fs.symlinkSync(source, link, 'junction');
              links.push(link);
            }
          }
          return await fn(root);
        } finally {
          for (const link of links) removeLink(link);
        }
      },
    });
  } finally {
    dropReplayBase(where);
  }
}

/**
 * The reference: the escaped head with every fix cherry-picked on top, oldest first, then the
 * hidden test files put back to what head has (or removed when head lacks them). The patch is cut
 * from the resulting tree object against the base (`git write-tree`, `git diff-tree`), so it is
 * LF whatever the host's autocrlf says and never depends on the worktree's files.
 *
 * @returns {{ ok: true, patch: Buffer, tree: string, changed: string[] } | { ok: false, commit: string, message: string }}
 */
function buildReference({ root, task, hiddenPaths }) {
  for (const fix of task.fixes) {
    const pick = git(root, ['cherry-pick', '--no-commit', fix.commit]);
    if (pick.status !== 0) return { ok: false, commit: fix.commit, message: (pick.stderr || pick.stdout.toString('utf8')).trim().slice(-800) };
  }
  for (const rel of hiddenPaths) {
    if (git(root, ['cat-file', '-e', `${task.head}:${rel}`]).status === 0) git(root, ['checkout', task.head, '--', rel]);
    else {
      git(root, ['rm', '-f', '-q', '--cached', '--ignore-unmatch', '--', rel]);
      fs.rmSync(path.join(root, rel), { force: true });
    }
  }
  const written = git(root, ['write-tree']);
  const tree = written.stdout.toString('utf8').trim();
  if (written.status !== 0 || !tree) throw new Error(`git write-tree for the reference failed: ${written.stderr.trim()}`);
  // Cut from a git directory with no working tree to look at: inside the worktree, git reuses the
  // checked-out file for a blob it matches in the index, and with autocrlf that file has CRLF.
  const common = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.toString('utf8').trim();
  const neutral = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-reference-patch-'));
  let diff;
  try {
    diff = git(
      neutral,
      ['diff-tree', '-p', '--binary', '--no-color', '--no-ext-diff', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', task.base, tree, '--', '.', ...hiddenPaths.map((p) => `:(exclude,literal)${p}`)],
      { lf: true, env: { GIT_DIR: common, GIT_WORK_TREE: neutral, GIT_INDEX_FILE: path.join(neutral, 'index') } },
    );
  } finally {
    fs.rmSync(neutral, { recursive: true, force: true });
  }
  if (diff.status !== 0) throw new Error(`git diff-tree for the reference failed: ${diff.stderr.trim()}`);
  const names = git(root, ['diff-tree', '-r', '-z', '--no-renames', '--name-only', task.base, tree]);
  if (names.status !== 0) throw new Error(`git diff-tree --name-only for the reference failed: ${names.stderr.trim()}`);
  return { ok: true, patch: diff.stdout, tree, changed: names.stdout.toString('utf8').split('\0').filter(Boolean) };
}

/** Test files beside the hidden tests, at the base, that have a replay rule. Sorted, capped. */
function regressionCandidates({ task, config, hiddenPaths, cap }) {
  /** @type {Map<string, TestEntry>} */
  const found = new Map();
  for (const dir of new Set(hiddenPaths.map((p) => path.posix.dirname(p)))) {
    for (const { mode, type, oid, rel } of lsTree(task.repoDir, task.base, dir)) {
      if (type !== 'blob' || mode === '120000' || !TEST_FILE.test(path.posix.basename(rel)) || hiddenPaths.includes(rel)) continue;
      const rule = resolveReplayRule(config, task.repo === '.' ? rel : `${task.repo}/${rel}`);
      if (!rule) continue;
      const within = withinOf(task.repo, rule.cwd);
      if (outsideRepo(within)) continue;
      found.set(rel, { path: rel, argv: replayArgv({ repo: task.repo, testPath: rel, rule }), rule, within, oid });
    }
  }
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path)).slice(0, cap);
}

const blob = (repoDir, rev, rel) => {
  const r = git(repoDir, ['cat-file', 'blob', `${rev}:${rel}`]);
  return r.status === 0 ? r.stdout : null;
};

const sha256 = (/** @type {Buffer} */ bytes) => createHash('sha256').update(bytes).digest('hex');

/** Rule cwds, relative to the repository, that have no lockfile of their own at the base. */
function cwdsWithoutLockfile({ task, withins }) {
  return withins.filter((within) => !lsTree(task.repoDir, task.base, within).some((e) => e.type === 'blob' && LOCKFILES.includes(path.posix.basename(e.rel))));
}

/**
 * The files the verifier holds the agent to, at the base: each rule cwd's manifest, lockfile and
 * runner configuration (see `deps.mjs`), plus the package-manager rc files (`.npmrc`, `.yarnrc`,
 * `.yarnrc.yml`) of the cwd and of every ancestor up to the repository root. Read from git
 * objects, so only tracked files count.
 */
function protectedFiles({ task, withins }) {
  /** @type {Map<string, { path: string, cwd: string, sha256: string, bytes: Buffer }>} */
  const out = new Map();
  const add = (/** @type {string} */ within, /** @type {(name: string) => boolean} */ wanted) => {
    for (const { mode, type, rel } of lsTree(task.repoDir, task.base, within)) {
      if (type !== 'blob' || mode === '120000' || !wanted(path.posix.basename(rel)) || out.has(rel)) continue;
      const bytes = blob(task.repoDir, task.base, rel);
      if (bytes) out.set(rel, { path: rel, cwd: within, sha256: sha256(bytes), bytes });
    }
  };
  for (const within of withins) add(within, isProtectedName);
  for (const within of withins) for (const folder of folderAndAncestors(within)) add(folder, isRcName);
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Build the reference for a candidate and calibrate it.
 *
 * @param {Record<string, any>} task a candidate from `collectSessions`
 * @param {{ projectRoot: string, config: unknown, timeoutSec?: number, regressionCap?: number }} opts
 *   `timeoutSec` is per test, and the verifier uses the same number
 * @returns {Promise<{ ok: true, patch: Buffer, hidden: Array<Record<string, any>>, regression: Array<Record<string, any>>,
 *   protectedFiles: Array<{ path: string, cwd: string, sha256: string, bytes: Buffer }> }
 *   | { ok: false, reason: string, detail?: Record<string, any> }>}
 */
export async function calibrateCandidate(task, { projectRoot, config, timeoutSec = DEFAULT_REPLAY_TIMEOUT_SEC, regressionCap = REGRESSION_CAP }) {
  /** @type {TestEntry[]} */
  const hidden = [];
  /** @type {Array<{ path: string, bytes: Buffer }>} */
  const hiddenFiles = [];
  for (const h of task.hiddenTests) {
    const within = withinOf(task.repo, h.cwd);
    if (outsideRepo(within)) return { ok: false, reason: 'unsafe-path', detail: { test: h.path, cwd: h.cwd } };
    const bytes = blob(task.repoDir, h.commit, h.path);
    if (!bytes) return { ok: false, reason: 'missing-test', detail: { test: h.path, commit: h.commit } };
    hidden.push({ path: h.path, argv: h.argv, rule: h.rule ?? task.rule, within, commit: h.commit });
    hiddenFiles.push({ path: h.path, bytes });
  }
  const hiddenPaths = hidden.map((h) => h.path);
  const candidates = regressionCandidates({ task, config, hiddenPaths, cap: regressionCap });
  const all = [...hidden, ...candidates];

  // Without a lockfile of its own the verifier's install would resolve whatever is newest today,
  // not what calibration ran against. Nothing is run for such a session.
  const unpinned = cwdsWithoutLockfile({ task, withins: [...new Set(all.map((t) => t.within))].sort() });
  if (unpinned.length) return { ok: false, reason: 'unpinned-deps', detail: { cwds: unpinned } };

  // 1. Base: every hidden test must fail (a timeout or a missing module is a failure here).
  const onBase = await inTree({
    task, projectRoot, rev: task.base, files: hiddenFiles, tests: all,
    fn: async (root) => {
      const res = await runTests(root, hidden, timeoutSec);
      if (res.some(passed)) return { hidden: res, regression: [] };
      return { hidden: res, regression: await runTests(root, candidates, timeoutSec) };
    },
  });
  const basePassing = onBase.hidden.filter(passed).map((r) => r.path);
  if (basePassing.length) return { ok: false, reason: 'passes-on-base', detail: { tests: basePassing } };

  // 2. Escaped head: every hidden test must fail.
  const onHead = await inTree({ task, projectRoot, rev: task.head, files: hiddenFiles, tests: hidden, fn: (root) => runTests(root, hidden, timeoutSec) });
  const headPassing = onHead.filter(passed).map((r) => r.path);
  if (headPassing.length) return { ok: false, reason: 'not-failing-on-head', detail: { tests: headPassing } };

  // 3. Reference: head plus the fixes; every hidden test must pass, and so must the regression
  // files that pass on base. The verifier grades the base bytes of a regression file, so only a
  // file that is the same blob in the reference counts: otherwise it is not what ran here.
  const passingOnBase = candidates.filter((c) => onBase.regression.some((r) => r.path === c.path && passed(r)));
  const onReference = await inTree({
    task, projectRoot, rev: task.head, files: [], tests: [...hidden, ...passingOnBase],
    fn: async (root) => {
      const ref = buildReference({ root, task, hiddenPaths });
      if (!ref.ok) return { conflict: ref };
      const withins = new Set(all.map((t) => t.within));
      const rcFolders = new Set([...withins].flatMap(folderAndAncestors));
      const touched = ref.changed.filter((rel) => {
        const dir = path.posix.dirname(rel);
        const name = path.posix.basename(rel);
        return (withins.has(dir) && isProtectedName(name)) || (rcFolders.has(dir) && isRcName(name));
      });
      if (touched.length) return { dependencyChange: touched };
      const unchanged = passingOnBase.filter((c) => git(root, ['rev-parse', '--verify', '--quiet', `${ref.tree}:${c.path}`]).stdout.toString('utf8').trim() === c.oid);
      writeFiles(root, hiddenFiles);
      return { patch: ref.patch, unchanged, hidden: await runTests(root, hidden, timeoutSec), regression: await runTests(root, unchanged, timeoutSec) };
    },
  });
  if (onReference.conflict) return { ok: false, reason: 'reference-conflict', detail: { commit: onReference.conflict.commit, message: onReference.conflict.message } };
  if (onReference.dependencyChange) return { ok: false, reason: 'dependency-change', detail: { files: onReference.dependencyChange } };
  const refFailing = onReference.hidden.filter((r) => !passed(r));
  if (refFailing.length) return { ok: false, reason: 'not-passing-on-reference', detail: { tests: refFailing.map(failure) } };

  const regressionPassing = new Set(onReference.regression.filter(passed).map((r) => r.path));
  const regression = onReference.unchanged.filter((c) => regressionPassing.has(c.path));
  const shape = (/** @type {TestEntry} */ t, /** @type {Buffer} */ bytes) => ({ path: t.path, sha256: sha256(bytes), argv: t.argv, cwd: t.within, bytes });
  return {
    ok: true,
    patch: onReference.patch,
    hidden: hidden.map((t, i) => ({ ...shape(t, hiddenFiles[i].bytes), commit: t.commit })),
    // The base bytes: the same blob as the reference's, checked above.
    regression: regression.map((t) => shape(t, /** @type {Buffer} */ (blob(task.repoDir, task.base, t.path)))),
    protectedFiles: protectedFiles({ task, withins: [...new Set([...hidden, ...regression].map((t) => t.within))].sort() }),
  };
}
