/**
 * Escape tracking (CONTEXT.md): which later commits went back and rewrote a
 * done change's lines, and the operator's verdict on each.
 *
 * An **Escape candidate** is a non-merge commit, within 14 days after a
 * session reached done, that modifies or deletes at least one line `git blame`
 * attributes to the session's **Commit range**. The blame runs on the
 * candidate's *parent*, over exactly the old-side lines of its `-U0` hunks —
 * the lines it removes or rewrites — so "touches the change's lines" is git's
 * own answer, not a line-tracking scheme of ours.
 *
 * Decisions live in `<project>/.forge/escapes.jsonl` under the ledger lock.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readLedger, withLedgerLock, writeLedger } from './ledger.mjs';
import { listFleet, projectNameFor } from './lib/fleet.mjs';
import { nestedBaseCommits } from './lib/nested-repos.mjs';
import { normalizePlanDir, resolveProjectPlanEngine } from './plan-engine.mjs';
import { CONCRETE_PACES } from './preferences.mjs';

export const WINDOW_DAYS = 14;
const WINDOW_MS = WINDOW_DAYS * 86400000;
const SHA_LINE = /^([0-9a-f]{40}) \d+ \d+/;

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string | null} stdout, or null when git failed
 */
function git(cwd, args) {
  const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return r.status === 0 ? r.stdout : null;
}

const lines = (text) => (text ?? '').split('\n').filter(Boolean);

/**
 * Done sessions of this repository: the project's `sessions.jsonl` done rows,
 * plus fleet registry `done` entries for the same repository — this root, or
 * another checkout with the same repository name (linked worktrees, which is
 * how volo runs parallel sessions, and whose `.forge/` dies with them).
 * Deduped by session id; the digest row wins, borrowing the registry's range
 * when it has none.
 *
 * @param {{ cwd: string }} opts
 * @returns {Array<{ sessionId: string, slug: string | null, startedAt: string | null, doneAt: string | null,
 *   forgekitVersion: string | null, commitRange: { base: string, head: string } | null,
 *   nestedCommitRanges: Record<string, { base: string, head: string }> | null, project: string }>}
 */
export function doneSessions({ cwd }) {
  const root = path.resolve(cwd);
  /** @type {Map<string, any>} */
  const byId = new Map();
  for (const row of readLedger(path.join(root, '.forge', 'sessions.jsonl'))) {
    if (row.phase !== 'done' || !row.sessionId) continue;
    byId.set(row.sessionId, {
      sessionId: row.sessionId,
      slug: row.slug ?? null,
      startedAt: row.startedAt ?? null,
      doneAt: row.endedAt ?? null,
      forgekitVersion: row.forgekitVersion ?? null,
      commitRange: row.commitRange ?? null,
      nestedCommitRanges: row.nestedCommitRanges ?? null,
      project: root,
    });
  }
  const name = projectNameFor(root);
  for (const e of listFleet()) {
    if (e.phase !== 'done' || !e.sessionId) continue;
    if (path.resolve(e.project) !== root && e.projectName !== name) continue;
    const known = byId.get(e.sessionId);
    if (known) {
      known.commitRange ??= e.commitRange ?? null;
      known.nestedCommitRanges ??= e.nestedCommitRanges ?? null;
      known.startedAt ??= e.createdAt ?? null;
      continue;
    }
    byId.set(e.sessionId, {
      sessionId: e.sessionId,
      slug: e.slug ?? null,
      startedAt: e.createdAt ?? null,
      doneAt: e.updatedAt ?? null,
      forgekitVersion: null, // the registry does not record the release
      commitRange: e.commitRange ?? null,
      nestedCommitRanges: e.nestedCommitRanges ?? null,
      project: e.project,
    });
  }
  return [...byId.values()].sort((a, b) => String(a.doneAt).localeCompare(String(b.doneAt)));
}

/**
 * A range for a session that finished before ranges were recorded, from its
 * `forge(<slug>):` checkpoint/archive commits on `rev`: base = the oldest's
 * parent, head = the newest. Null when there are none — a session that never
 * checkpointed has no knowable range, and a guessed one would invent Escapes.
 *
 * @param {{ cwd: string, slug: string | null, rev?: string }} opts
 * @returns {{ base: string, head: string } | null}
 */
export function inferCommitRange({ cwd, slug, rev = 'HEAD' }) {
  if (!slug) return null;
  const prefix = `forge(${slug}):`;
  const out = git(cwd, ['log', '--format=%H%x09%s', '--fixed-strings', `--grep=${prefix}`, rev]);
  const own = lines(out)
    .map((l) => l.split('\t'))
    .filter(([, subject]) => subject?.startsWith(prefix))
    .map(([sha]) => sha);
  if (own.length === 0) return null;
  const base = git(cwd, ['rev-parse', '--verify', '--quiet', `${own[own.length - 1]}^`])?.trim();
  return base ? { base, head: own[0] } : null;
}

/**
 * What commit `c` did to each file: `[status, oldPath, newPath]`, from
 * `--name-status -z`, so paths arrive raw — no quoting, no `a/` prefix, no
 * trailing tab for a path with a space (all of which a parsed patch header
 * gets wrong, and silently: a lost path is a lost Escape).
 *
 * @param {string} cwd
 * @param {string} c
 * @returns {Array<[string, string, string]>}
 */
function changedFiles(cwd, c) {
  return memo('changed', `${cwd}\0${c}`, () => changedFilesUncached(cwd, c));
}

/**
 * F29: per-commit git results are the same for every session that looks at the commit (git
 * objects never change), so one run computes each once. On Volo every later commit was re-diffed
 * and re-blamed by each of the ~30 sessions whose 14-day window covered it (~66 s per session).
 *
 * ponytail: process-lifetime cache, no eviction — a CLI run is short; bound it if a server ever imports this.
 */
const CACHE = { changed: new Map(), ranges: new Map(), blame: new Map() };
const STATS = { changed: { hits: 0, misses: 0 }, ranges: { hits: 0, misses: 0 }, blame: { hits: 0, misses: 0 } };

/**
 * @template T
 * @param {'changed' | 'ranges' | 'blame'} kind
 * @param {string} key
 * @param {() => T} compute
 * @returns {T}
 */
function memo(kind, key, compute) {
  const cache = /** @type {Map<string, T>} */ (CACHE[kind]);
  if (cache.has(key)) {
    STATS[kind].hits += 1;
    return /** @type {T} */ (cache.get(key));
  }
  STATS[kind].misses += 1;
  const value = compute();
  cache.set(key, value);
  return value;
}

/** Cache hit/miss counts per kind, for tests and diagnostics. */
export function escapeCacheStats() {
  return JSON.parse(JSON.stringify(STATS));
}

/** @param {string} cwd @param {string} c */
function changedFilesUncached(cwd, c) {
  const tokens = (git(cwd, ['diff', '--name-status', '-z', '-M', '--no-ext-diff', `${c}^`, c]) ?? '').split('\0');
  /** @type {Array<[string, string, string]>} */
  const out = [];
  for (let i = 0; i < tokens.length && tokens[i]; ) {
    const status = tokens[i];
    if (status.startsWith('R') || status.startsWith('C')) {
      out.push([status[0], tokens[i + 1], tokens[i + 2]]);
      i += 3;
    } else {
      out.push([status[0], tokens[i + 1], tokens[i + 1]]);
      i += 2;
    }
  }
  return out;
}

/**
 * Old-side `[start, count]` ranges that commit `c` removes or rewrites in one
 * file. Only `@@` lines are read: every body line of a patch starts with `-`,
 * `+`, ` ` or `\`, so a removed `-- comment` can never pass for a header.
 *
 * @param {string} cwd
 * @param {string} c
 * @param {string[]} paths the old path, plus the new one for a rename
 * @returns {Array<[number, number]>}
 */
function oldSideRanges(cwd, c, paths) {
  return memo('ranges', `${cwd}\0${c}\0${paths.join('\0')}`, () => oldSideRangesUncached(cwd, c, paths));
}

/** @param {string} cwd @param {string} c @param {string[]} paths @returns {Array<[number, number]>} */
function oldSideRangesUncached(cwd, c, paths) {
  /** @type {Array<[number, number]>} */
  const ranges = [];
  const diff = git(cwd, ['diff', '-U0', '-M', '--no-color', '--no-ext-diff', `${c}^`, c, '--', ...paths]) ?? '';
  for (const line of diff.split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+/.exec(line);
    const count = m ? (m[2] === undefined ? 1 : Number(m[2])) : 0;
    if (m && count > 0) ranges.push([Number(m[1]), count]);
  }
  return ranges;
}

/** @param {string} cwd @param {string} sha @param {string} rev */
const isAncestor = (cwd, sha, rev) => spawnSync('git', ['merge-base', '--is-ancestor', sha, rev], { cwd }).status === 0;

/**
 * Escape candidates for one done session: its root Commit range, then each
 * nested repository's range, every one blamed in its own repository. A
 * candidate's `repo` is `"."` for the root, else the nested path. A session is
 * skipped only when no repository could be searched. A range that exists but
 * cannot be searched (repo gone, head off the scanned ref) is always named in
 * `unsearched`, searched session or not, so a partial result is never silent.
 * `probe` checks the ranges without blaming anything (the report's cheap pass).
 *
 * @param {{ cwd: string, session: { sessionId: string, slug?: string | null, doneAt?: string | null,
 *   commitRange?: { base: string, head: string } | null,
 *   nestedCommitRanges?: Record<string, { base: string, head: string }> | null,
 *   inferredCommits?: Record<string, string[]> | null }, rev?: string, probe?: boolean }} opts
 * @returns {{ sessionId: string, range: { base: string, head: string } | null, inferred: boolean,
 *   skipped: string | null, unsearched: string[], candidates: Array<{ commit: string, subject: string, at: string,
 *   files: string[], lines: number, outsidePlan: string[], repo: string, inferred?: 'time-window' }> }}
 */
export function escapeCandidates({ cwd, session, rev = 'HEAD', probe = false }) {
  const scan = (/** @type {string} */ dir, /** @type {string} */ repo, /** @type {string} */ scanRev, /** @type {{ base: string, head: string }} */ r) =>
    probe ? [] : scanRepo({ cwd: dir, repo, session, rev: scanRev, range: r, ...rangeCommits(dir, r) });
  let range = session.commitRange?.base && session.commitRange?.head ? session.commitRange : null;
  let inferred = false;
  // A recorded head that is not on `rev` was rebased (or squashed) on its way
  // in; its `forge(<slug>):` subjects survive a rebase, so try those first.
  if (!range || !isAncestor(cwd, range.head, rev)) {
    const guess = inferCommitRange({ cwd, slug: session.slug ?? null, rev });
    if (guess || !range) {
      range = guess;
      inferred = true;
    }
  }
  /** @type {{ sessionId: string, range: typeof range, inferred: boolean, skipped: string | null, unsearched: string[], candidates: any[] }} */
  const result = { sessionId: session.sessionId, range, inferred, skipped: null, unsearched: [], candidates: [] };
  /** @type {string[]} */
  const skips = [];
  let searched = false;
  /** A range that exists but cannot be searched: a skip reason, and never silent. @param {string} reason */
  const lost = (reason) => {
    skips.push(reason);
    result.unsearched.push(reason);
  };
  // No range at all is not a lost one: nothing was recorded to search.
  if (!range) skips.push('no commit range (none recorded, no forge(<slug>) commits)');
  else if (!isAncestor(cwd, range.head, rev)) lost(`head ${range.head.slice(0, 7)} not on ${rev} (unmerged or squash-merged)`);
  else {
    searched = true;
    result.candidates.push(...scan(cwd, '.', rev, range));
  }

  for (const [repo, nested] of Object.entries(session.nestedCommitRanges ?? {})) {
    const dir = nestedDir(cwd, repo);
    if (!dir) {
      lost(`${repo}: repository is gone`);
      continue;
    }
    // ponytail: a nested repo is scanned at `rev` when it has that ref, else at its HEAD.
    const nestedRev = git(dir, ['rev-parse', '--verify', '--quiet', rev]) ? rev : 'HEAD';
    if (!isAncestor(dir, nested.head, nestedRev)) {
      lost(`${repo}: head ${nested.head.slice(0, 7)} not on ${nestedRev} (unmerged or squash-merged)`);
      continue;
    }
    searched = true;
    result.candidates.push(...scan(dir, repo, nestedRev, nested));
  }

  // Sessions recorded before per-repository ranges: the commits `inferNestedWindows`
  // attributed to this session's time window. Not a contiguous range, so there is no
  // ancestor check; the newest commit stands in for the head.
  for (const [repo, shas] of Object.entries(session.inferredCommits ?? {})) {
    const dir = nestedDir(cwd, repo);
    if (!dir || shas.length === 0 || probe) continue;
    const nestedRev = git(dir, ['rev-parse', '--verify', '--quiet', rev]) ? rev : 'HEAD';
    const files = lines(git(dir, ['log', '--no-walk=unsorted', '--format=', '--name-only', '--no-renames', ...shas]));
    searched = true;
    result.candidates.push(
      ...scanRepo({ cwd: dir, repo, session, rev: nestedRev, range: { base: '', head: shas[0] }, changeCommits: new Set(shas), files, inferred: 'time-window' }),
    );
  }
  return { ...result, skipped: searched ? null : skips.join('; ') };}

/** @param {string} cwd @param {string} repo @returns {string | null} the nested repo's directory, or null when it is gone */
function nestedDir(cwd, repo) {
  const dir = path.join(cwd, repo);
  return fs.existsSync(path.join(dir, '.git')) ? dir : null;
}

/**
 * Time-window inference (CONTEXT.md, Commit range): for each done session with
 * no recorded `nestedCommitRanges`, the commits of every nested repo that
 * exists under `cwd` now whose committer time falls in the session's
 * `[startedAt, endedAt]` (to the second, ends included), across all branches.
 * A commit in several sessions' windows goes to the one with the shortest.
 *
 * ponytail: only sessions that themselves need inferring compete for a commit;
 * a session with recorded ranges is not weighed, so a parallel session's commit
 * can be attributed to an older, longer one. The candidate stays marked `inferred`.
 *
 * @param {{ cwd: string, sessions: Array<{ sessionId: string, startedAt?: string | null, doneAt?: string | null,
 *   nestedCommitRanges?: unknown }> }} opts
 * @returns {Map<string, Record<string, string[]>>} sessionId → repo → shas, newest first; sessions with none are absent
 */
export function inferNestedWindows({ cwd, sessions }) {
  const windows = sessions
    .filter((s) => !s.nestedCommitRanges)
    .map((s) => ({ id: s.sessionId, from: Math.floor(Date.parse(s.startedAt ?? '') / 1000), to: Math.floor(Date.parse(s.doneAt ?? '') / 1000) }))
    .filter((w) => Number.isFinite(w.from) && Number.isFinite(w.to) && w.from <= w.to);
  /** @type {Map<string, Record<string, string[]>>} */
  const out = new Map();
  if (windows.length === 0) return out;
  for (const repo of Object.keys(nestedBaseCommits(cwd))) {
    const dir = nestedDir(cwd, repo);
    if (!dir) continue;
    for (const l of lines(git(dir, ['log', '--all', '--no-merges', '--format=%H%x09%ct']))) {
      const [sha, ct] = l.split('\t');
      const t = Number(ct);
      let best = null;
      for (const w of windows) {
        if (t >= w.from && t <= w.to && (!best || w.to - w.from < best.to - best.from)) best = w;
      }
      if (!best) continue;
      const repos = out.get(best.id) ?? {};
      (repos[repo] ??= []).push(sha);
      out.set(best.id, repos);
    }
  }
  return out;
}

/**
 * The commits of a recorded range, and the files it touched. First parent
 * only: a `git merge main` mid-session brings other sessions' commits into
 * base..head, and their lines are not this change's. Blame credits those lines
 * to their own commits, which this set then excludes.
 *
 * @param {string} cwd
 * @param {{ base: string, head: string }} range
 * @returns {{ changeCommits: Set<string>, files: string[] }}
 */
function rangeCommits(cwd, range) {
  return {
    changeCommits: new Set(lines(git(cwd, ['rev-list', '--first-parent', `${range.base}..${range.head}`]))),
    files: lines(git(cwd, ['diff', '--name-only', '--no-renames', range.base, range.head])),
  };
}

/**
 * Blame the later commits of one repository against the change's commits.
 * The plan-dir and `.forge/` rules, and the F16 plan documents, belong to the
 * root repository (`repo` `"."`) alone.
 *
 * @param {{ cwd: string, repo: string, session: { slug?: string | null, doneAt?: string | null },
 *   rev: string, range: { base: string, head: string }, changeCommits: Set<string>, files: string[],
 *   inferred?: 'time-window' }} opts
 */
function scanRepo({ cwd, repo, session, rev, range, changeCommits, files: changedByChange, inferred }) {
  const isRoot = repo === '.';
  let planDir = 'openspec';
  try {
    if (isRoot) planDir = normalizePlanDir(resolveProjectPlanEngine(cwd).dir);
  } catch {
    // unreadable config — keep the default
  }
  const isCode = (/** @type {string} */ f) => !isRoot || (!f.startsWith(`${planDir}/`) && !f.startsWith('.forge/'));
  /** Paths that may hold change lines — the change's own files, followed through renames. */
  const tracked = new Set(changedByChange.filter(isCode));
  /** @type {Array<{ commit: string, subject: string, at: string, files: string[], lines: number, outsidePlan: string[], repo: string, inferred?: 'time-window' }>} */
  const found = [];
  if (tracked.size === 0) return found;

  // F16 (a sweep is an unrelated edit that rode along on a checkpoint): the
  // change's own plan documents, read at head, say which files it meant to touch.
  // ponytail: basename substring match, so a common basename (`index.ts`) reads
  // as named and the flag can miss a sweep. It labels a candidate; it never hides one.
  const planFiles = isRoot ? lines(git(cwd, ['diff', '--name-only', '--diff-filter=d', range.base, range.head, '--', `${planDir}/`])) : [];
  const { head } = range;
  const planText = planFiles.length ? (git(cwd, ['show', ...planFiles.map((f) => `${head}:${f}`)]) ?? '') : '';

  const doneMs = Date.parse(session.doneAt ?? '') || Date.parse(git(cwd, ['show', '-s', '--format=%cI', range.head])?.trim() ?? '');
  const since = new Date(doneMs).toISOString();
  const until = new Date(doneMs + WINDOW_MS).toISOString();
  const later = lines(
    git(cwd, ['log', '--reverse', '--no-merges', '--format=%H%x09%cI%x09%s', `--since=${since}`, `--until=${until}`, rev, `^${range.head}`]),
  ).map((l) => {
    const [commit, at, ...subject] = l.split('\t');
    return { commit, at, subject: subject.join('\t') };
  });

  const ownPrefix = session.slug ? `forge(${session.slug})` : null;
  for (const c of later) {
    const sameSession = changeCommits.has(c.commit) || (ownPrefix && c.subject.startsWith(ownPrefix));
    let hit = 0;
    const files = [];
    for (const [status, from, to] of changedFiles(cwd, c.commit)) {
      if (!tracked.has(from) || status === 'A' || status === 'C') continue;
      if (status === 'R' && isCode(to)) tracked.add(to);
      if (sameSession) continue;
      const ranges = oldSideRanges(cwd, c.commit, status === 'R' ? [from, to] : [from]);
      if (ranges.length === 0) continue;
      const origins = memo('blame', `${cwd}\0${c.commit}\0${from}`, () =>
        lines(git(cwd, ['blame', '--porcelain', ...ranges.flatMap(([a, n]) => ['-L', `${a},+${n}`]), `${c.commit}^`, '--', from]))
          .map((l) => SHA_LINE.exec(l)?.[1] ?? '')
          .filter(Boolean),
      );
      const n = origins.filter((sha) => changeCommits.has(sha)).length;
      if (n > 0) {
        hit += n;
        files.push(from);
      }
    }
    if (hit > 0) {
      const outsidePlan = planFiles.length ? files.filter((f) => !planText.includes(path.posix.basename(f))) : [];
      found.push({ commit: c.commit, subject: c.subject, at: c.at, files, lines: hit, outsidePlan, repo, ...(inferred && { inferred }) });
    }
  }
  return found;
}

/** @param {string} cwd */
export function escapesLedgerPath(cwd) {
  return path.join(path.resolve(cwd), '.forge', 'escapes.jsonl');
}

/** @param {string} cwd */
export function readDecisions(cwd) {
  return readLedger(escapesLedgerPath(cwd));
}

const TEST_FILE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[^/]+$|_test\.[^/]+$|(^|\/)test_[^/]+\.py$/;

/** A conventional `fix`/`revert` subject, or git's own `Revert "…"`. */
const FIX_SUBJECT = /^(fix|revert)(\([^)]*\))?!?:|^Revert "/i;

/**
 * Whether a commit subject marks a fix or a revert — the only commits an Escape can be
 * (CONTEXT.md). A later feature that touches a change's lines and adds a test for new behavior
 * also fails before and passes after, so it must never be auto-confirmed (Volo: 233 of 425).
 *
 * ponytail: subject convention only; a fix written as `client: …` is left for the operator.
 *
 * @param {unknown} subject
 * @returns {boolean}
 */
export function isFixCommit(subject) {
  return typeof subject === 'string' && FIX_SUBJECT.test(subject);
}

/**
 * The test a fix commit added or changed — the default replay test when the
 * operator confirms an Escape. First match in git's path order.
 *
 * @param {{ cwd: string, commit: string }} opts
 * @returns {string | null}
 */
export function replayTestFor({ cwd, commit }) {
  return replayTestsFor({ cwd, commit })[0] ?? null;
}

/**
 * Every test a fix commit added or changed, in git's path order — the
 * candidates for a replay, of which `forge escapes verify` takes the first with a rule.
 *
 * @param {{ cwd: string, commit: string }} opts
 * @returns {string[]}
 */
export function replayTestsFor({ cwd, commit }) {
  return lines(git(cwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--diff-filter=AM', '--root', commit])).filter((f) =>
    TEST_FILE.test(f),
  );
}

/**
 * Record the operator's verdict on one candidate. Confirming requires a replay
 * test (CONTEXT.md): the supplied path, else the fix commit's own test; the
 * path must exist in the fix commit's tree or on disk. A re-decision on the
 * same (session, commit) replaces the earlier line. For a candidate in a nested
 * repository (`repo`), the commit and the replay test are that repository's;
 * the ledger stays the project's.
 *
 * @param {{ cwd: string, sessionId: string, slug?: string | null, commit: string,
 *   decision: string, replayTest?: string | null, reason?: string | null,
 *   repo?: string, inferred?: string | null, auto?: boolean, command?: string | null,
 *   oldExit?: number | null, fixExit?: number | null }} opts
 *   `auto`, `command`, `oldExit` and `fixExit` are what `forge escapes verify` records for a replay it ran.
 * @returns {{ ok: true, entry: Record<string, any> } | { ok: false, error: string }}
 */
export function decide({
  cwd: root,
  sessionId,
  slug = null,
  commit,
  decision,
  replayTest = null,
  reason = null,
  repo = '.',
  inferred = null,
  auto = false,
  command = null,
  oldExit = null,
  fixExit = null,
}) {
  if (decision !== 'confirmed' && decision !== 'dismissed') {
    return { ok: false, error: `decision must be confirmed or dismissed, got: ${decision}` };
  }
  const cwd = repo === '.' ? root : path.join(root, repo);
  const sha = git(cwd, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`])?.trim();
  if (!sha) return { ok: false, error: `not a commit in this repository: ${commit}` };
  let test = null;
  if (decision === 'confirmed') {
    test = replayTest ?? replayTestFor({ cwd, commit: sha });
    if (!test) {
      return { ok: false, error: `commit ${sha.slice(0, 7)} touched no test — confirm with --test <path> to a replay test you wrote` };
    }
    // Repo-relative, posix — the replay will run it from this repository.
    const rel = path.relative(path.resolve(cwd), path.resolve(cwd, test));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      return { ok: false, error: `replay test must be a file inside this repository: ${test}` };
    }
    test = rel.split(path.sep).join('/');
    const inCommit = spawnSync('git', ['cat-file', '-e', `${sha}:${test}`], { cwd }).status === 0;
    let onDisk = false;
    try {
      onDisk = fs.statSync(path.resolve(cwd, test)).isFile();
    } catch {
      // not on disk
    }
    if (!inCommit && !onDisk) {
      return { ok: false, error: `replay test not found as a file in ${sha.slice(0, 7)} or on disk: ${test}` };
    }
  }
  const entry = {
    sessionId,
    slug,
    commit: sha,
    subject: git(cwd, ['show', '-s', '--format=%s', sha])?.trim() ?? null,
    decision,
    replayTest: test,
    reason,
    ...(repo !== '.' && { repo }),
    ...(inferred && { inferred }),
    ...(auto && { auto: true, command, oldExit, fixExit }),
    decidedAt: new Date().toISOString(),
  };
  const file = escapesLedgerPath(root);
  withLedgerLock(file, () => {
    const kept = readLedger(file).filter((e) => !(e.sessionId === sessionId && e.commit === sha));
    writeLedger(file, [...kept, entry]);
  });
  return { ok: true, entry };
}

/** @param {string} cwd */
export function escapeTagsPath(cwd) {
  return path.join(path.resolve(cwd), '.forge', 'escape-tags.jsonl');
}

/**
 * What `forge escapes verify` learned about a candidate it could not confirm —
 * `environment`, `not-reproduced`, or `undecided` with a reason. Not a
 * decision: the candidate stays pending. Latest per (session, commit) wins.
 *
 * @param {string} cwd
 * @returns {Array<{ sessionId: string, commit: string, repo: string, tag: string, reason: string | null,
 *   command: string | null, oldExit: number | null, fixExit: number | null, at: string }>}
 */
export function readTags(cwd) {
  /** @type {Map<string, any>} */
  const latest = new Map();
  for (const t of readLedger(escapeTagsPath(cwd))) latest.set(`${t.sessionId} ${t.commit}`, t);
  return [...latest.values()];
}

/**
 * @param {{ cwd: string, sessionId: string, commit: string, repo?: string, tag: string, reason?: string | null,
 *   command?: string | null, oldExit?: number | null, fixExit?: number | null }} opts
 */
export function tagCandidate({ cwd, sessionId, commit, repo = '.', tag, reason = null, command = null, oldExit = null, fixExit = null }) {
  const entry = { sessionId, commit, repo, tag, reason, command, oldExit, fixExit, at: new Date().toISOString() };
  const file = escapeTagsPath(cwd);
  withLedgerLock(file, () => {
    const kept = readLedger(file).filter((e) => !(e.sessionId === sessionId && e.commit === commit));
    writeLedger(file, [...kept, entry]);
  });
  return entry;
}

/**
 * Candidates still waiting on the operator, per done session of this repo. A
 * candidate `forge escapes verify` tagged carries it as `tag`.
 *
 * @param {{ cwd: string, rev?: string, sessionId?: string }} opts `sessionId` limits the blame to one session
 */
export function pendingCandidates({ cwd, rev = 'HEAD', sessionId }) {
  const decided = new Set(readDecisions(cwd).map((d) => `${d.sessionId} ${d.commit}`));
  const tags = new Map(readTags(cwd).map((t) => [`${t.sessionId} ${t.commit}`, t]));
  const sessions = doneSessions({ cwd });
  // The windows of all sessions are weighed against each other, so infer before narrowing.
  const windows = inferNestedWindows({ cwd, sessions });
  return sessions.filter((s) => !sessionId || s.sessionId === sessionId).map((session) => {
    const result = escapeCandidates({ cwd, session: { ...session, inferredCommits: windows.get(session.sessionId) }, rev });
    return {
      ...result,
      slug: session.slug,
      doneAt: session.doneAt,
      candidates: result.candidates
        .filter((c) => !decided.has(`${session.sessionId} ${c.commit}`))
        .map((c) => {
          const tag = tags.get(`${session.sessionId} ${c.commit}`);
          return tag ? { ...c, tag } : c;
        }),
    };
  });
}

/**
 * Which repository a commit named on the command line belongs to, and whether
 * its range was inferred: from the earlier decision on it, else from the
 * session's pending candidates. `{ repo: '.' }` when neither knows it.
 *
 * @param {{ cwd: string, sessionId: string, commit: string, rev?: string }} opts `commit` may be abbreviated
 * @returns {{ repo: string, inferred: string | null }}
 */
export function candidateOrigin({ cwd, sessionId, commit, rev = 'HEAD' }) {
  const prior = readDecisions(cwd).find((d) => d.sessionId === sessionId && d.commit?.startsWith(commit));
  const found =
    prior ??
    pendingCandidates({ cwd, rev, sessionId })
      .flatMap((s) => s.candidates)
      .find((c) => c.commit.startsWith(commit));
  return { repo: found?.repo ?? '.', inferred: found?.inferred ?? null };
}

/**
 * Escape rate per month of done and per pace, across the fleet: this project
 * plus every registry project still on disk (`forge fleet report`'s discovery),
 * and the registry's own done entries — the only trace a deleted worktree
 * leaves. A session counts as escaped once any project's ledger confirms an
 * Escape for it; `open` counts sessions whose 14-day window has not closed, so
 * a recent bucket's rate is provisional. A session's pace is the one recorded
 * at done (digest row, else registry entry), else `unknown`; `byPace` runs
 * thorough..lite, then other recorded values alphabetically, `unknown` last.
 *
 * With `by: 'version'` the report also carries `byVersion`: the same columns per
 * `forgekitVersion` recorded on the digest row (the registry does not record
 * one), oldest release first, `unknown` for sessions without one, last.
 *
 * @param {{ cwd: string, now?: number, by?: 'version' | null }} opts
 */
export function escapeReport({ cwd, now = Date.now(), by = null }) {
  const fleet = listFleet();
  const roots = new Set([path.resolve(cwd), ...fleet.filter((e) => !e.missing).map((e) => path.resolve(e.project))]);
  /** @type {Map<string, { at: string, pace: string | null, version: string | null }>} sessionId → done time, pace and forgekit version */
  const done = new Map();
  const escaped = new Set();
  /** Sessions whose every confirmed Escape came from an inferred range. */
  const inferredOnly = new Set();
  const notInferred = new Set();
  for (const root of roots) {
    for (const row of readLedger(path.join(root, '.forge', 'sessions.jsonl'))) {
      if (row.phase === 'done' && row.sessionId && row.endedAt) {
        done.set(row.sessionId, { at: row.endedAt, pace: row.pace ?? null, version: row.forgekitVersion ?? null });
      }
    }
    for (const d of readDecisions(root)) {
      if (d.decision !== 'confirmed') continue;
      escaped.add(d.sessionId);
      (d.inferred ? inferredOnly : notInferred).add(d.sessionId);
    }
  }
  for (const e of fleet) {
    if (e.phase !== 'done' || !e.sessionId || !e.updatedAt) continue;
    const known = done.get(e.sessionId);
    if (!known) done.set(e.sessionId, { at: e.updatedAt, pace: e.pace ?? null, version: null });
    else known.pace ??= e.pace ?? null;
  }

  /** @type {Map<string, { month: string, done: number, escaped: number, rate: number, open: number }>} */
  const months = new Map();
  /** @type {Map<string, { pace: string, done: number, escaped: number, rate: number, open: number }>} */
  const paces = new Map();
  const total = { done: 0, escaped: 0, rate: 0, open: 0 };
  /** @type {Map<string, { version: string, done: number, escaped: number, rate: number, open: number }>} */
  const versions = new Map();
  for (const [id, { at, pace, version }] of done) {
    const month = at.slice(0, 7);
    const paceKey = pace || 'unknown';
    const versionKey = version || 'unknown';
    if (!months.has(month)) months.set(month, { month, done: 0, escaped: 0, rate: 0, open: 0 });
    if (!paces.has(paceKey)) paces.set(paceKey, { pace: paceKey, done: 0, escaped: 0, rate: 0, open: 0 });
    if (!versions.has(versionKey)) versions.set(versionKey, { version: versionKey, done: 0, escaped: 0, rate: 0, open: 0 });
    const m = /** @type {NonNullable<ReturnType<typeof months.get>>} */ (months.get(month));
    const p = /** @type {NonNullable<ReturnType<typeof paces.get>>} */ (paces.get(paceKey));
    const v = /** @type {NonNullable<ReturnType<typeof versions.get>>} */ (versions.get(versionKey));
    for (const bucket of [m, p, v, total]) {
      bucket.done += 1;
      if (escaped.has(id)) bucket.escaped += 1;
      if (now - Date.parse(at) < WINDOW_MS) bucket.open += 1;
    }
  }
  for (const bucket of [...months.values(), ...paces.values(), ...versions.values(), total]) {
    bucket.rate = bucket.done ? bucket.escaped / bucket.done : 0;
  }
  // Of the escaped sessions, those resting only on inferred ranges (time-window guesses).
  const inferred = { escaped: [...done.keys()].filter((id) => inferredOnly.has(id) && !notInferred.has(id)).length };
  // Sessions of this project with a recorded range that cannot be searched, so their
  // escape count may be partial. Ranges are only probed, never blamed.
  const unsearched = {
    sessions: doneSessions({ cwd }).filter((session) => escapeCandidates({ cwd, session, probe: true }).unsearched.length > 0).length,
  };
  /** @param {string} pace */
  const paceRank = (pace) => (pace === 'unknown' ? 2 : CONCRETE_PACES.includes(pace) ? 0 : 1);
  return {
    projects: [...roots],
    months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    byPace: [...paces.values()].sort(
      (a, b) =>
        paceRank(a.pace) - paceRank(b.pace) ||
        (paceRank(a.pace) === 0 ? CONCRETE_PACES.indexOf(a.pace) - CONCRETE_PACES.indexOf(b.pace) : a.pace.localeCompare(b.pace)),
    ),
    ...(by === 'version'
      ? {
          byVersion: [...versions.values()].sort(
            (a, b) =>
              (a.version === 'unknown') - (b.version === 'unknown') ||
              a.version.localeCompare(b.version, 'en', { numeric: true }),
          ),
        }
      : {}),
    total,
    inferred,
    // Present only when a session has an unsearchable range, so a clean report keeps its shape.
    ...(unsearched.sessions > 0 && { unsearched }),
  };
}
