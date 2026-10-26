#!/usr/bin/env node
/**
 * Export a project's confirmed escapes as the local Harbor corpus `forgekit-escape-replays-v1`
 * (specs/changes/escape-replays). One candidate task per escaped session: the nested repository at
 * the session's base, the archived change's proposal and specs as the instruction, and the fix
 * commits whose tests are the hidden checks.
 *
 * Collect the candidates, snapshot their base trees, then calibrate each (`escape-replays/calibrate.mjs`)
 * against its hidden tests: base and escaped head must fail them, the reference must pass them.
 *
 * Usage: FORGEKIT_ALLOW_EXEC=1 node evals/harbor/export-escape-replays.mjs --project <path>
 *          [--include <relpath>]… [--out <dir>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadProjectConfig } from '../../packages/cli/src/config.mjs';
import { doneSessions, inferNestedWindows, readDecisions } from '../../packages/cli/src/escapes.mjs';
import { replayArgv, resolveReplayRule } from '../../packages/cli/src/escapes-replay.mjs';
import { ALLOW_EXEC_ENV, envAllowsCallerExec } from '../../packages/cli/src/exec-gate.mjs';
import { escapeReplaysCorpusId, localCorpusRoot } from './corpus-selection.mjs';
import { calibrateCandidate } from './escape-replays/calibrate.mjs';
import { corpusManifest, writeTask } from './escape-replays/write-task.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The forgekit checkout this script lives in. */
const checkoutRoot = path.resolve(here, '..', '..');

export const defaultOutDir = path.join(localCorpusRoot, escapeReplaysCorpusId);

const USAGE = `Usage: ${ALLOW_EXEC_ENV}=1 node evals/harbor/export-escape-replays.mjs --project <path> [--include <relpath>]... [--out <dir>]
`;

/** Archived changes live under the planning engine's archive folder, as `YYYY-MM-DD-<slug>`. */
const ARCHIVE_DIRS = ['openspec/changes/archive', 'specs/changes/archive'];

/** @param {string} cwd @param {string[]} args @returns {string | null} stdout, or null when git failed */
function git(cwd, args) {
  const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/** @param {string} rel */
const posix = (rel) => rel.replace(/\\/g, '/');

/**
 * Refuse unless the operator opted in to executing project commands, the same switch `forge
 * evidence -- <cmd>` and `forge escapes verify` check.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function assertExecAllowed(env = process.env) {
  if (envAllowsCallerExec(env)) return;
  throw new Error(
    'export-escape-replays: refusing to run project commands without operator opt-in.\n' +
      'The export replays recorded tests, which executes the project\'s own commands as you.\n' +
      `Opt in with ${ALLOW_EXEC_ENV}=1.`,
  );
}

/**
 * Why a relative path inside a repository is unusable, or its normalized form: it must not be
 * empty, absolute, drive-qualified, or contain a `..` segment.
 *
 * @param {unknown} rel
 * @returns {{ message: string, norm?: undefined } | { norm: string, message?: undefined }}
 */
function checkRelative(rel) {
  const p = posix(String(rel ?? ''));
  if (p === '' || /^[A-Za-z]:/.test(p) || p.startsWith('/')) return { message: 'must be a relative path inside the nested repository' };
  if (p.split('/').includes('..')) return { message: 'must not contain ".."' };
  const norm = path.posix.normalize(p);
  if (norm === '.') return { message: 'must name a file or folder' };
  return { norm };
}

/**
 * An `--include` path names an ignored file of the nested checkout to copy into the snapshot.
 * Absolute paths and any `..` segment are refused, before anything is written.
 *
 * @param {string} rel
 * @returns {string} the normalized posix path
 */
export function validateInclude(rel) {
  const checked = checkRelative(rel);
  if (checked.message) throw new Error(`--include ${checked.message}, got: ${rel}`);
  return /** @type {string} */ (checked.norm);
}

/** A ledger `repo` is `.` or a safe relative path; its `replayTest` and `commit` get the same care as `--include`. */
const safeLedgerRepo = (/** @type {unknown} */ repo) => repo === '.' || checkRelative(repo).norm !== undefined;
const safeLedgerCommit = (/** @type {unknown} */ commit) => typeof commit === 'string' && /^[0-9a-f]{7,64}$/i.test(commit);

/**
 * Refuse an output directory inside the forgekit checkout that git does not ignore: exported
 * tasks hold a private project's source and must never be one `git add` away from the repository.
 *
 * @param {string} out
 */
export function assertOutDirSafe(out) {
  const rel = path.relative(checkoutRoot, path.resolve(out));
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return;
  const child = posix(path.join(rel, '_'));
  const ignored = spawnSync('git', ['check-ignore', '-q', '--', child], { cwd: checkoutRoot }).status === 0;
  if (!ignored) {
    throw new Error(`--out ${out} is inside the forgekit checkout and is not ignored by git.
Export to a git-ignored folder such as evals/harbor/local/, or outside the checkout.`);
  }
}

/** @param {string} slug */
function taskIdBase(slug) {
  return String(slug ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/g, '');
}

/** The task id for a session: its slug when that leaves something, else a short hash of the session id. */
const taskIdFor = (/** @type {string | null} */ slug, /** @type {string} */ sessionId) =>
  taskIdBase(slug) || `escape-${createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 10)}`;

/**
 * The archived change for a slug: the latest `<project>/<archive>/YYYY-MM-DD-<slug>` directory,
 * trying each planning engine's archive folder in turn.
 *
 * @param {string} project
 * @param {string | null} slug
 * @returns {string | null} absolute path
 */
export function findArchivedChange(project, slug) {
  if (!slug) return null;
  for (const archive of ARCHIVE_DIRS) {
    const dir = path.join(project, archive);
    let names;
    try {
      names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue;
    }
    const match = names
      .filter((n) => /^\d{4}-\d{2}-\d{2}-/.test(n) && n.slice(11) === slug)
      .sort()
      .pop();
    if (match) return path.join(dir, match);
  }
  return null;
}

/** @param {string} dir @returns {string[]} `spec.md` files under dir, posix-relative, sorted */
function specFiles(dir) {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {string} */ abs, /** @type {string} */ rel) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(abs, e.name), childRel);
      else if (e.isFile() && e.name === 'spec.md') out.push(childRel);
    }
  };
  walk(dir, '');
  return out.sort();
}

/**
 * The agent's instruction: the change's proposal, then every capability spec. Never `design.md`,
 * `tasks.md` or the brief, which are Forge's own plan output.
 *
 * @param {string} changeDir
 * @returns {string | null} null when the change holds neither a proposal nor a spec
 */
export function buildInstruction(changeDir) {
  /** @type {string[]} */
  const parts = [];
  const proposal = path.join(changeDir, 'proposal.md');
  if (fs.existsSync(proposal)) parts.push(`# Proposal\n\n${fs.readFileSync(proposal, 'utf8').trim()}`);
  for (const rel of specFiles(path.join(changeDir, 'specs'))) {
    parts.push(`# Spec: ${rel}\n\n${fs.readFileSync(path.join(changeDir, 'specs', rel), 'utf8').trim()}`);
  }
  return parts.length ? `${parts.join('\n\n')}\n` : null;
}

/**
 * Latest decision per (session, commit), confirmed only.
 *
 * @param {string} project
 * @returns {Array<Record<string, any>>}
 */
function confirmedEscapes(project) {
  const latest = new Map();
  for (const row of readDecisions(project)) latest.set(`${row.sessionId}\0${row.commit}`, row);
  return [...latest.values()].filter((r) => r.decision === 'confirmed');
}

/** @param {string} repoDir @param {string} sha */
const commitTime = (repoDir, sha) => Number(git(repoDir, ['show', '-s', '--format=%ct', sha])?.trim()) || 0;

/**
 * The Commit range of one session in one repository, as base and head shas.
 *
 * @returns {{ base: string, head: string, inferred: boolean } | null}
 */
function sessionRange({ session, repo, repoDir, inferred }) {
  const recorded = repo === '.' ? session?.commitRange : session?.nestedCommitRanges?.[repo];
  let range = recorded ? { base: recorded.base, head: recorded.head, inferred: false } : null;
  if (!range) {
    const shas = inferred.get(session?.sessionId)?.[repo];
    if (!shas?.length) return null;
    const parent = git(repoDir, ['rev-parse', '--verify', '--quiet', `${shas[shas.length - 1]}^`])?.trim();
    if (!parent) return null;
    range = { base: parent, head: shas[0], inferred: true };
  }
  const resolve = (/** @type {string} */ rev) => git(repoDir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])?.trim();
  const base = resolve(range.base);
  const head = resolve(range.head);
  return base && head ? { base, head, inferred: range.inferred } : null;
}

/**
 * Turn a project's confirmed escapes into candidate tasks, one per escaped session, and the
 * sessions that cannot be tasks with one reason each. Reads the ledger and git only.
 *
 * @param {{ project: string }} opts
 * @returns {{ kept: Array<Record<string, any>>, drops: Array<{ sessionId: string, slug: string | null, reason: string }>,
 *   skipped: Array<{ sessionId: string, commit: string, reason: string }> }} `skipped` lists the escapes left out of every session, kept or dropped
 */
export function collectSessions({ project }) {
  const root = path.resolve(project);
  const config = loadProjectConfig(root);
  const sessions = doneSessions({ cwd: root });
  const bySession = new Map(sessions.map((s) => [s.sessionId, s]));
  const inferred = inferNestedWindows({ cwd: root, sessions });

  /** @type {Map<string, Array<Record<string, any>>>} */
  const grouped = new Map();
  for (const row of confirmedEscapes(root)) {
    if (!grouped.has(row.sessionId)) grouped.set(row.sessionId, []);
    grouped.get(row.sessionId)?.push(row);
  }

  const kept = [];
  const drops = [];
  /** @type {Array<{ sessionId: string, commit: string, reason: string }>} */
  const skipped = [];
  const usedIds = new Set();
  for (const [sessionId, rows] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    const slug = rows.find((r) => r.slug)?.slug ?? bySession.get(sessionId)?.slug ?? null;
    const drop = (/** @type {string} */ reason) => drops.push({ sessionId, slug, reason });

    // Rows the exporter cannot trust: a ledger path or commit that could reach outside the repository.
    /** @type {Array<{ commit: string, reason: string }>} */
    const skippedEscapes = [];
    const usable = [];
    for (const r of rows) {
      const unsafeCommit = !safeLedgerCommit(r.commit);
      if (!safeLedgerRepo(r.repo ?? '.') || (r.replayTest != null && checkRelative(r.replayTest).norm === undefined) || unsafeCommit) {
        skippedEscapes.push({ commit: r.commit, reason: unsafeCommit ? 'bad-commit' : 'unsafe-path' });
      } else usable.push(r);
    }

    // Rule-backed escapes per repository; the session lives in the repository with the most.
    /** @type {Map<string, Array<{ row: Record<string, any>, rule: Record<string, any>, argv: string[] }>>} */
    const backed = new Map();
    /** @type {Array<Record<string, any>>} */
    const unbacked = [];
    for (const r of usable) {
      const repoOfRow = r.repo == null || r.repo === '.' ? '.' : path.posix.normalize(posix(r.repo)).replace(/\/+$/, '');
      const testPath = r.replayTest ? path.posix.normalize(posix(r.replayTest)) : null;
      const rule = testPath ? resolveReplayRule(config, repoOfRow === '.' ? testPath : `${repoOfRow}/${testPath}`) : null;
      if (!rule || !testPath) {
        unbacked.push(r);
        continue;
      }
      const list = backed.get(repoOfRow) ?? [];
      list.push({ row: { ...r, replayTest: testPath }, rule, argv: replayArgv({ repo: repoOfRow, testPath, rule }) });
      backed.set(repoOfRow, list);
    }
    const ranked = [...backed].sort(([ra, la], [rb, lb]) => lb.length - la.length || ra.localeCompare(rb));
    if (ranked.length === 0) {
      for (const r of unbacked) skippedEscapes.push({ commit: r.commit, reason: 'unsupported-runner' });
      skipped.push(...skippedEscapes.map((x) => ({ sessionId, ...x })));
      drop(usable.length === 0 ? 'unsafe-path' : 'unsupported-runner');
      continue;
    }
    const [[repo, supported]] = ranked;
    for (const r of unbacked) skippedEscapes.push({ commit: r.commit, reason: 'unsupported-runner' });
    for (const [, list] of ranked.slice(1)) {
      for (const { row } of list) skippedEscapes.push({ commit: row.commit, reason: 'unsupported-runner' });
    }
    skipped.push(...skippedEscapes.map((x) => ({ sessionId, ...x })));
    const repoDir = repo === '.' ? root : path.join(root, repo);

    const changeDir = findArchivedChange(root, slug);
    const instruction = changeDir ? buildInstruction(changeDir) : null;
    if (!instruction) {
      drop('no-spec');
      continue;
    }

    const range = sessionRange({ session: bySession.get(sessionId), repo, repoDir, inferred });
    if (!range) {
      drop('no-base');
      continue;
    }

    // Oldest fix first: the order the reference applies them in.
    supported.sort((a, b) => commitTime(repoDir, a.row.commit) - commitTime(repoDir, b.row.commit));
    const fixes = supported.map(({ row, argv }) => ({ commit: row.commit, replayTest: row.replayTest, command: row.command ?? argv.join(' ') }));
    /** Newest fix wins when two fixes touch one test file. */
    const hidden = new Map();
    for (const { row, rule, argv } of supported) hidden.set(row.replayTest, { path: row.replayTest, commit: row.commit, argv, cwd: rule.cwd, rule });

    const idBase = taskIdFor(slug, sessionId);
    let taskId = idBase;
    for (let n = 2; usedIds.has(taskId); n += 1) taskId = `${idBase}-${n}`;
    usedIds.add(taskId);

    kept.push({
      sessionId,
      slug,
      taskId,
      repo,
      repoDir,
      base: range.base,
      head: range.head,
      inferred: range.inferred,
      fixes,
      hiddenTests: [...hidden.values()],
      rule: supported[0].rule,
      skippedEscapes,
      specDir: changeDir,
      instruction,
    });
  }
  return { kept, drops, skipped };
}

/**
 * Whether `git archive` of the tree at `rev` would not be that tree: it holds a symlink, which the
 * harness refuses in a task tree (and Windows tar would turn into a copy), or a `.gitattributes`
 * line with `export-ignore` (files left out of the archive) or `export-subst` (contents rewritten),
 * in the tree or in the repository's own `$GIT_DIR/info/attributes`.
 */
function hasUnsafeTree(repoDir, rev) {
  const listing = git(repoDir, ['ls-tree', '-r', rev]);
  if (listing === null) return false;
  const lines = listing.split('\n');
  if (lines.some((line) => line.startsWith('120000 '))) return true;
  const exportsAttribute = (/** @type {string} */ text) =>
    text.split(/\r?\n/).some((l) => !l.trim().startsWith('#') && /(?:^|\s)[-!]?export-(?:ignore|subst)(?:=|\s|$)/.test(l));
  for (const line of lines) {
    const m = /^\d+ blob ([0-9a-f]+)\t(.*)$/.exec(line);
    if (!m || path.posix.basename(m[2]) !== '.gitattributes') continue;
    if (exportsAttribute(git(repoDir, ['cat-file', 'blob', m[1]]) ?? '')) return true;
  }
  // The repository's own $GIT_DIR/info/attributes steers git archive too, and is not in the tree.
  const info = git(repoDir, ['rev-parse', '--git-path', 'info/attributes'])?.trim();
  if (info) {
    try {
      if (exportsAttribute(fs.readFileSync(path.resolve(repoDir, info), 'utf8'))) return true;
    } catch {
      /* no such file: nothing to steer */
    }
  }
  return false;
}

/**
 * Extract `git archive <base>` of a repository into `dest`: tracked files only, no `.git`, no
 * ignored files, LF bytes whatever the host's autocrlf says. Then copy each `include` path from
 * the operator's checkout.
 *
 * @param {{ repoDir: string, base: string, dest: string, include?: string[], tar?: string[] }} opts
 *   `tar` is the extractor argv (default `tar -xf -`); tests swap it for a broken one
 * @returns {Promise<string[]>} the include paths that were copied
 */
export async function snapshotBase({ repoDir, base, dest, include = [], tar: tarArgv = ['tar', '-xf', '-'] }) {
  const safe = include.map(validateInclude);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  await new Promise((resolve, reject) => {
    const archive = spawn('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=tar', base], { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] });
    const tar = spawn(tarArgv[0], tarArgv.slice(1), { cwd: dest, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const finish = (/** @type {Error | null} */ error) => {
      if (settled) return;
      settled = true;
      if (error) {
        archive.kill();
        tar.kill();
        reject(error);
      } else resolve(undefined);
    };
    for (const child of [archive, tar]) child.stderr.on('data', (d) => { stderr += d; });
    archive.on('error', (e) => finish(new Error(`could not run git archive: ${e.message}`)));
    tar.on('error', (e) => finish(new Error(`could not run ${tarArgv[0]}: ${e.message}`)));
    // The extractor may stop reading early (EPIPE); its exit status and stderr tell why.
    tar.stdin.on('error', () => {});
    archive.stdout.on('error', () => {});
    archive.stdout.pipe(tar.stdin);
    let archiveExit = null;
    let tarExit = null;
    const settle = () => {
      if (archiveExit === null || tarExit === null) return;
      if (archiveExit === 0 && tarExit === 0) finish(null);
      else finish(new Error(`could not extract ${base} of ${repoDir}: ${stderr.trim() || `exit ${archiveExit}/${tarExit}`}`));
    };
    archive.on('close', (code) => { archiveExit = code; settle(); });
    tar.on('close', (code) => { tarExit = code; settle(); });
  });
  /** @type {string[]} */
  const copied = [];
  for (const rel of safe) {
    const src = path.join(repoDir, rel);
    let info;
    try {
      info = fs.lstatSync(src);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) throw new Error(`--include ${rel} is a symbolic link; name the file it points to`);
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.cpSync(src, path.join(dest, rel), { recursive: true });
    copied.push(rel);
  }
  return copied;
}

/** Where a candidate's agent-environment snapshot goes. */
export const snapshotDir = (/** @type {string} */ out, /** @type {{ taskId: string }} */ task) => path.join(out, 'tasks', task.taskId, 'environment', 'app');

/**
 * Write each candidate's base snapshot. An include path found in none of the candidates'
 * checkouts is an error, raised before anything is written. A candidate whose base tree holds a
 * symlink or an `export-ignore`/`export-subst` attribute is dropped as `unsafe-tree` without being
 * extracted.
 *
 * @param {{ kept: Array<Record<string, any>>, out: string, include?: string[] }} opts
 * @returns {Promise<{ kept: Array<Record<string, any>>, dropped: Array<{ sessionId: string, slug: string | null, reason: string }> }>}
 */
export async function writeSnapshots({ kept, out, include = [] }) {
  const safe = include.map(validateInclude);
  // With nothing left to snapshot there is nothing to look in; the report still gets written.
  if (kept.length > 0) {
    for (const rel of safe) {
      if (!kept.some((t) => fs.existsSync(path.join(t.repoDir, rel)))) {
        throw new Error(`--include ${rel} was not found in any nested checkout`);
      }
    }
  }
  const ok = [];
  const dropped = [];
  for (const task of kept) {
    if (hasUnsafeTree(task.repoDir, task.base)) {
      dropped.push({ sessionId: task.sessionId, slug: task.slug, reason: 'unsafe-tree' });
      continue;
    }
    task.included = await snapshotBase({ repoDir: task.repoDir, base: task.base, dest: snapshotDir(out, task), include: safe });
    ok.push(task);
  }
  return { kept: ok, dropped };
}

/**
 * Collect the candidates and write their base snapshots. Runs no project command.
 *
 * @param {{ project: string, include?: string[], out: string }} opts
 */
export async function prepareCandidates({ project, include = [], out }) {
  const safe = include.map(validateInclude);
  const collected = collectSessions({ project });
  const { kept, dropped } = await writeSnapshots({ kept: collected.kept, out, include: safe });
  return { kept, drops: [...collected.drops, ...dropped], skipped: collected.skipped };
}

/**
 * Remove what an earlier export of this corpus left in `out`, so a re-export never mixes
 * generations. Only a folder whose manifest or report names this corpus is touched: an export
 * that kept nothing writes a report but no manifest.
 *
 * @param {string} out
 */
function clearPreviousExport(out) {
  const names = (/** @type {string} */ file) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(out, file), 'utf8')).corpus_id === escapeReplaysCorpusId;
    } catch {
      return false;
    }
  };
  if (!names('corpus.json') && !names('export-report.json')) return;
  for (const name of ['tasks', 'corpus.json', 'export-report.json']) fs.rmSync(path.join(out, name), { recursive: true, force: true });
}

/**
 * Warnings for replay rules that copy ignored files (`copy`, such as `.env`) which exist in the
 * operator's checkout but which `--include` does not put in the snapshot. Calibration ran with
 * them; the agent and the verifier have no copy, so those tasks cannot be graded without them.
 *
 * @param {{ kept: Array<Record<string, any>>, include: string[] }} o `include` is already validated
 * @returns {string[]}
 */
export function copyWarnings({ kept, include }) {
  /** @type {Map<string, Set<string>>} rule match -> the uncovered files, relative to the project */
  const uncovered = new Map();
  for (const task of kept) {
    for (const rule of [task.rule, ...task.hiddenTests.map((/** @type {{ rule?: Record<string, any> }} */ h) => h.rule)]) {
      if (!rule) continue;
      const within = task.repo === '.' ? path.posix.normalize(posix(rule.cwd ?? '.')) : path.posix.relative(posix(task.repo), path.posix.normalize(posix(rule.cwd ?? '.'))) || '.';
      for (const file of rule.copy ?? []) {
        const inRepo = path.posix.normalize(path.posix.join(within, posix(file)));
        if (inRepo.startsWith('..') || !fs.existsSync(path.join(task.repoDir, inRepo))) continue;
        if (include.some((inc) => inRepo === inc || inRepo.startsWith(`${inc}/`))) continue;
        const set = uncovered.get(rule.match) ?? new Set();
        set.add(path.posix.normalize(path.posix.join(posix(rule.cwd ?? '.'), posix(file))));
        uncovered.set(rule.match, set);
      }
    }
  }
  return [...uncovered].map(
    ([match, files]) =>
      `replay rule "${match}" copies ${[...files].sort().join(', ')}, which --include does not cover (name it relative to the nested repository): the snapshot and the verifier have no copy, so tasks whose tests need it cannot be graded without it`,
  );
}

/**
 * Export: collect the candidates, snapshot their bases, calibrate each against its hidden tests
 * and write the report. A candidate that fails calibration is dropped with its reason and its
 * partial task folder removed.
 *
 * @param {{ project: string, include?: string[], out?: string, env?: NodeJS.ProcessEnv, timeoutSec?: number, regressionCap?: number }} opts
 */
export async function exportEscapeReplays({ project, include = [], out = defaultOutDir, env = process.env, timeoutSec, regressionCap }) {
  assertExecAllowed(env);
  assertOutDirSafe(out);
  const safe = include.map(validateInclude);
  const projectRoot = path.resolve(project);
  clearPreviousExport(out);
  const prepared = await prepareCandidates({ project: projectRoot, include: safe, out });
  const config = loadProjectConfig(projectRoot);

  const drops = [...prepared.drops];
  const kept = [];
  for (const task of prepared.kept) {
    let calibration;
    try {
      calibration = await calibrateCandidate(task, { projectRoot, config, timeoutSec, regressionCap });
    } catch (error) {
      calibration = { ok: false, reason: 'calibration-error', detail: { message: error.message } };
    }
    if (!calibration.ok) {
      fs.rmSync(path.join(out, 'tasks', task.taskId), { recursive: true, force: true });
      drops.push({ sessionId: task.sessionId, slug: task.slug, reason: calibration.reason, ...(calibration.detail && { detail: calibration.detail }) });
      continue;
    }
    task.calibration = calibration;
    writeTask({ out, task, calibration, timeoutSec });
    kept.push(task);
  }

  const report = {
    corpus_id: escapeReplaysCorpusId,
    kept: kept.map((t) => ({
      taskId: t.taskId,
      sessionId: t.sessionId,
      slug: t.slug,
      repo: t.repo,
      hidden: t.calibration.hidden.length,
      regression: t.calibration.regression.length,
    })),
    drops,
    skippedEscapes: prepared.skipped,
    warnings: copyWarnings({ kept, include: safe }),
  };
  fs.mkdirSync(out, { recursive: true });
  // The manifest is what registers the corpus with the runner, so only an export that kept a task writes one.
  if (kept.length > 0) fs.writeFileSync(path.join(out, 'corpus.json'), `${JSON.stringify(corpusManifest(kept), null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'export-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return { kept, drops, report };
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {{ project: string | null, include: string[], out: string | undefined }} */
  const opts = { project: null, include: [], out: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!['--project', '--include', '--out'].includes(flag)) throw new Error(`unknown argument: ${flag}`);
    if (value === undefined) throw new Error(`${flag} needs a value`);
    i += 1;
    if (flag === '--include') opts.include.push(value);
    else if (flag === '--project') opts.project = value;
    else opts.out = path.resolve(value);
  }
  if (!opts.project) throw new Error('--project <path> is required');
  return opts;
}

async function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const { report } = await exportEscapeReplays({ project: /** @type {string} */ (opts.project), include: opts.include, out: opts.out });
    for (const warning of report.warnings) process.stderr.write(`warning: ${warning}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n${/--project|unknown argument|needs a value/.test(error.message) ? USAGE : ''}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
