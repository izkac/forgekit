#!/usr/bin/env node
/**
 * Export a project's confirmed escapes as the local Harbor corpus `forgekit-escape-replays-v1`
 * (specs/changes/escape-replays). One candidate task per escaped session: the nested repository at
 * the session's base, the archived change's proposal and specs as the instruction, and the fix
 * commits whose tests are the hidden checks.
 *
 * This module collects candidates and snapshots the base trees. Calibration, the reference build,
 * the task writer and the grader extend `exportEscapeReplays` between `collectSessions` and
 * `writeSnapshots`.
 *
 * Usage: FORGEKIT_ALLOW_EXEC=1 node evals/harbor/export-escape-replays.mjs --project <path>
 *          [--include <relpath>]… [--out <dir>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadProjectConfig } from '../../packages/cli/src/config.mjs';
import { doneSessions, inferNestedWindows, readDecisions } from '../../packages/cli/src/escapes.mjs';
import { replayArgv, resolveReplayRule } from '../../packages/cli/src/escapes-replay.mjs';
import { ALLOW_EXEC_ENV, envAllowsCallerExec } from '../../packages/cli/src/exec-gate.mjs';
import { escapeReplaysCorpusId } from './corpus-selection.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export const defaultOutDir = path.join(here, 'local', escapeReplaysCorpusId);

const USAGE = `Usage: ${ALLOW_EXEC_ENV}=1 node evals/harbor/export-escape-replays.mjs --project <path> [--include <relpath>]... [--out <dir>]
`;

/** Archived changes live under the planning engine's archive folder, as `YYYY-MM-DD-<slug>`. */
const ARCHIVE_DIRS = ['openspec/changes/archive', 'specs/changes/archive'];

/** The only runner the verifier knows how to install and run. */
const JEST_TOKEN = /(^|[\\/])jest([\\/.]|$)/i;

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
 * An `--include` path names an ignored file of the nested checkout to copy into the snapshot.
 * Absolute paths and any `..` segment are refused, before anything is written.
 *
 * @param {string} rel
 * @returns {string} the normalized posix path
 */
export function validateInclude(rel) {
  const p = posix(String(rel));
  if (p === '' || /^[A-Za-z]:/.test(p) || p.startsWith('/')) {
    throw new Error(`--include must be a relative path inside the nested repository, got: ${rel}`);
  }
  if (p.split('/').includes('..')) {
    throw new Error(`--include must not contain "..", got: ${rel}`);
  }
  const norm = path.posix.normalize(p);
  if (norm === '.') throw new Error(`--include must name a file or folder, got: ${rel}`);
  return norm;
}

/** Whether a replay command runs Jest: some argv token is a jest path or binary. */
export function isJestArgv(argv) {
  return argv.some((t) => JEST_TOKEN.test(t));
}

/** @param {string} slug */
function taskIdBase(slug) {
  return String(slug ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

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
 * @returns {{ kept: Array<Record<string, any>>, drops: Array<{ sessionId: string, slug: string | null, reason: string }> }}
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
  const usedIds = new Set();
  for (const [sessionId, rows] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    const slug = rows.find((r) => r.slug)?.slug ?? bySession.get(sessionId)?.slug ?? null;
    const drop = (/** @type {string} */ reason) => drops.push({ sessionId, slug, reason });

    // One repository per session: the one with the most confirmed escapes.
    const counts = new Map();
    for (const r of rows) counts.set(r.repo ?? '.', (counts.get(r.repo ?? '.') ?? 0) + 1);
    const repo = [...counts].sort(([ra, na], [rb, nb]) => nb - na || ra.localeCompare(rb))[0][0];
    const repoDir = repo === '.' ? root : path.join(root, repo);
    /** @type {Array<{ commit: string, reason: string }>} */
    const skippedEscapes = rows.filter((r) => (r.repo ?? '.') !== repo).map((r) => ({ commit: r.commit, reason: 'unsupported-runner' }));

    // Each fix needs a Jest replay rule; one without is skipped, and a session left with none is dropped.
    const supported = [];
    for (const r of rows.filter((x) => (x.repo ?? '.') === repo)) {
      const rule = r.replayTest ? resolveReplayRule(config, repo === '.' ? r.replayTest : `${repo}/${r.replayTest}`) : null;
      const argv = rule ? replayArgv({ repo, testPath: r.replayTest, rule }) : [];
      if (rule && isJestArgv(argv)) supported.push({ row: r, rule, argv });
      else skippedEscapes.push({ commit: r.commit, reason: 'unsupported-runner' });
    }
    if (supported.length === 0) {
      drop('unsupported-runner');
      continue;
    }

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
    for (const { row, rule, argv } of supported) hidden.set(row.replayTest, { path: row.replayTest, commit: row.commit, argv, cwd: rule.cwd });

    let taskId = taskIdBase(slug) || taskIdBase(sessionId);
    for (let n = 2; usedIds.has(taskId); n += 1) taskId = `${taskIdBase(slug) || taskIdBase(sessionId)}-${n}`;
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
  return { kept, drops };
}

/**
 * Extract `git archive <base>` of a repository into `dest`: tracked files only, no `.git`, no
 * ignored files. Then copy each `include` path from the operator's checkout.
 *
 * @param {{ repoDir: string, base: string, dest: string, include?: string[] }} opts
 * @returns {Promise<string[]>} the include paths that were copied
 */
export async function snapshotBase({ repoDir, base, dest, include = [] }) {
  const safe = include.map(validateInclude);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  await new Promise((resolve, reject) => {
    const archive = spawn('git', ['archive', '--format=tar', base], { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] });
    const tar = spawn('tar', ['-xf', '-'], { cwd: dest, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    for (const child of [archive, tar]) child.stderr.on('data', (d) => { stderr += d; });
    archive.on('error', reject);
    tar.on('error', reject);
    archive.stdout.pipe(tar.stdin);
    let archiveExit = null;
    let tarExit = null;
    const settle = () => {
      if (archiveExit === null || tarExit === null) return;
      if (archiveExit === 0 && tarExit === 0) resolve(undefined);
      else reject(new Error(`could not extract ${base} of ${repoDir}: ${stderr.trim() || `exit ${archiveExit}/${tarExit}`}`));
    };
    archive.on('close', (code) => { archiveExit = code; settle(); });
    tar.on('close', (code) => { tarExit = code; settle(); });
  });
  /** @type {string[]} */
  const copied = [];
  for (const rel of safe) {
    const src = path.join(repoDir, rel);
    if (!fs.existsSync(src)) continue;
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
 * checkouts is an error, raised before anything is written.
 *
 * @param {{ kept: Array<Record<string, any>>, out: string, include?: string[] }} opts
 */
export async function writeSnapshots({ kept, out, include = [] }) {
  const safe = include.map(validateInclude);
  for (const rel of safe) {
    if (!kept.some((t) => fs.existsSync(path.join(t.repoDir, rel)))) {
      throw new Error(`--include ${rel} was not found in any nested checkout`);
    }
  }
  for (const task of kept) {
    task.included = await snapshotBase({ repoDir: task.repoDir, base: task.base, dest: snapshotDir(out, task), include: safe });
  }
}

/** The shape of one candidate in `export-report.json`: everything but the paths and the instruction text. */
function candidateSummary(task) {
  const { repoDir, specDir, instruction, ...rest } = task;
  return rest;
}

/**
 * @param {{ project: string, include?: string[], out?: string, env?: NodeJS.ProcessEnv }} opts
 */
export async function exportEscapeReplays({ project, include = [], out = defaultOutDir, env = process.env }) {
  assertExecAllowed(env);
  const safe = include.map(validateInclude);
  const { kept, drops } = collectSessions({ project });
  await writeSnapshots({ kept, out, include: safe });
  const report = { corpus_id: escapeReplaysCorpusId, candidates: kept.map(candidateSummary), drops };
  fs.mkdirSync(out, { recursive: true });
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
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n${/--project|unknown argument|needs a value/.test(error.message) ? USAGE : ''}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
