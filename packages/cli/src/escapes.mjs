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
import { normalizePlanDir, resolveProjectPlanEngine } from './plan-engine.mjs';

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
 * @returns {Array<{ sessionId: string, slug: string | null, doneAt: string | null,
 *   commitRange: { base: string, head: string } | null, project: string }>}
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
      doneAt: row.endedAt ?? null,
      commitRange: row.commitRange ?? null,
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
      continue;
    }
    byId.set(e.sessionId, {
      sessionId: e.sessionId,
      slug: e.slug ?? null,
      doneAt: e.updatedAt ?? null,
      commitRange: e.commitRange ?? null,
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
 * Parse `git diff -U0 -M` into the old-side line ranges each hunk removes or
 * rewrites, keyed by old path, plus the renames it performed.
 *
 * @param {string} diff
 */
function oldSideHunks(diff) {
  /** @type {Map<string, Array<[number, number]>>} */
  const hunks = new Map();
  /** @type {Array<[string, string]>} */
  const renames = [];
  let oldPath = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) oldPath = null;
    else if (line.startsWith('rename from ')) oldPath = line.slice('rename from '.length);
    else if (line.startsWith('rename to ') && oldPath) renames.push([oldPath, line.slice('rename to '.length)]);
    else if (line.startsWith('--- ')) oldPath = line === '--- /dev/null' ? null : line.slice('--- a/'.length);
    else if (line.startsWith('@@ ') && oldPath) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+/.exec(line);
      const count = m ? (m[2] === undefined ? 1 : Number(m[2])) : 0;
      if (m && count > 0) {
        if (!hunks.has(oldPath)) hunks.set(oldPath, []);
        /** @type {Array<[number, number]>} */ (hunks.get(oldPath)).push([Number(m[1]), count]);
      }
    }
  }
  return { hunks, renames };
}

/**
 * Escape candidates for one done session.
 *
 * @param {{ cwd: string, session: { sessionId: string, slug?: string | null, doneAt?: string | null,
 *   commitRange?: { base: string, head: string } | null }, rev?: string }} opts
 * @returns {{ sessionId: string, range: { base: string, head: string } | null, inferred: boolean,
 *   skipped: string | null, candidates: Array<{ commit: string, subject: string, at: string,
 *   files: string[], lines: number }> }}
 */
export function escapeCandidates({ cwd, session, rev = 'HEAD' }) {
  let range = session.commitRange?.base && session.commitRange?.head ? session.commitRange : null;
  const inferred = !range;
  if (!range) range = inferCommitRange({ cwd, slug: session.slug ?? null, rev });
  const result = { sessionId: session.sessionId, range, inferred, skipped: null, candidates: [] };
  if (!range) return { ...result, skipped: 'no commit range (none recorded, no forge(<slug>) commits)' };
  if (spawnSync('git', ['merge-base', '--is-ancestor', range.head, rev], { cwd }).status !== 0) {
    return { ...result, skipped: `head ${range.head.slice(0, 7)} not on ${rev} (unmerged or squash-merged)` };
  }

  const changeCommits = new Set(lines(git(cwd, ['rev-list', `${range.base}..${range.head}`])));
  let planDir = 'openspec';
  try {
    planDir = normalizePlanDir(resolveProjectPlanEngine(cwd).dir);
  } catch {
    // unreadable config — keep the default
  }
  const isCode = (/** @type {string} */ f) => !f.startsWith(`${planDir}/`) && !f.startsWith('.forge/');
  /** Paths that may hold change lines — the change's own files, followed through renames. */
  const tracked = new Set(lines(git(cwd, ['diff', '--name-only', '--no-renames', range.base, range.head])).filter(isCode));
  if (tracked.size === 0) return result;

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
    const diff = git(cwd, ['diff', '-U0', '-M', '--no-color', `${c.commit}^`, c.commit]);
    if (diff === null) continue;
    const { hunks, renames } = oldSideHunks(diff);
    const sameSession = changeCommits.has(c.commit) || (ownPrefix && c.subject.startsWith(ownPrefix));
    let hit = 0;
    const files = [];
    if (!sameSession) {
      for (const [file, ranges] of hunks) {
        if (!tracked.has(file)) continue;
        const blame = git(cwd, ['blame', '--porcelain', ...ranges.flatMap(([a, n]) => ['-L', `${a},+${n}`]), `${c.commit}^`, '--', file]);
        const n = lines(blame).filter((l) => changeCommits.has(SHA_LINE.exec(l)?.[1] ?? '')).length;
        if (n > 0) {
          hit += n;
          files.push(file);
        }
      }
    }
    for (const [from, to] of renames) if (tracked.has(from) && isCode(to)) tracked.add(to);
    if (hit > 0) result.candidates.push({ commit: c.commit, subject: c.subject, at: c.at, files, lines: hit });
  }
  return result;
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

/**
 * The test a fix commit added or changed — the default replay test when the
 * operator confirms an Escape. First match in git's path order.
 *
 * @param {{ cwd: string, commit: string }} opts
 * @returns {string | null}
 */
export function replayTestFor({ cwd, commit }) {
  const files = lines(git(cwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--diff-filter=AM', '--root', commit]));
  return files.find((f) => TEST_FILE.test(f)) ?? null;
}

/**
 * Record the operator's verdict on one candidate. Confirming requires a replay
 * test (CONTEXT.md): the supplied path, else the fix commit's own test; the
 * path must exist in the fix commit's tree or on disk. A re-decision on the
 * same (session, commit) replaces the earlier line.
 *
 * @param {{ cwd: string, sessionId: string, slug?: string | null, commit: string,
 *   decision: string, replayTest?: string | null, reason?: string | null }} opts
 * @returns {{ ok: true, entry: Record<string, any> } | { ok: false, error: string }}
 */
export function decide({ cwd, sessionId, slug = null, commit, decision, replayTest = null, reason = null }) {
  if (decision !== 'confirmed' && decision !== 'dismissed') {
    return { ok: false, error: `decision must be confirmed or dismissed, got: ${decision}` };
  }
  const sha = git(cwd, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`])?.trim();
  if (!sha) return { ok: false, error: `not a commit in this repository: ${commit}` };
  let test = null;
  if (decision === 'confirmed') {
    test = replayTest ?? replayTestFor({ cwd, commit: sha });
    if (!test) {
      return { ok: false, error: `commit ${sha.slice(0, 7)} touched no test — confirm with --test <path> to a replay test you wrote` };
    }
    const inCommit = spawnSync('git', ['cat-file', '-e', `${sha}:${test}`], { cwd }).status === 0;
    if (!inCommit && !fs.existsSync(path.resolve(cwd, test))) {
      return { ok: false, error: `replay test not found in ${sha.slice(0, 7)} or on disk: ${test}` };
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
    decidedAt: new Date().toISOString(),
  };
  const file = escapesLedgerPath(cwd);
  withLedgerLock(file, () => {
    const kept = readLedger(file).filter((e) => !(e.sessionId === sessionId && e.commit === sha));
    writeLedger(file, [...kept, entry]);
  });
  return { ok: true, entry };
}

/**
 * Candidates still waiting on the operator, per done session of this repo.
 *
 * @param {{ cwd: string, rev?: string }} opts
 */
export function pendingCandidates({ cwd, rev = 'HEAD' }) {
  const decided = new Set(readDecisions(cwd).map((d) => `${d.sessionId} ${d.commit}`));
  return doneSessions({ cwd }).map((session) => {
    const result = escapeCandidates({ cwd, session, rev });
    return {
      ...result,
      slug: session.slug,
      doneAt: session.doneAt,
      candidates: result.candidates.filter((c) => !decided.has(`${session.sessionId} ${c.commit}`)),
    };
  });
}

/**
 * Escape rate per month of done, across the fleet: this project plus every
 * registry project still on disk (`forge fleet report`'s discovery), and the
 * registry's own done entries — the only trace a deleted worktree leaves.
 * A session counts as escaped once any project's ledger confirms an Escape for
 * it; `open` counts sessions whose 14-day window has not closed, so a recent
 * month's rate is provisional.
 *
 * @param {{ cwd: string, now?: number }} opts
 */
export function escapeReport({ cwd, now = Date.now() }) {
  const fleet = listFleet();
  const roots = new Set([path.resolve(cwd), ...fleet.filter((e) => !e.missing).map((e) => path.resolve(e.project))]);
  /** @type {Map<string, string>} sessionId → doneAt */
  const done = new Map();
  const escaped = new Set();
  for (const root of roots) {
    for (const row of readLedger(path.join(root, '.forge', 'sessions.jsonl'))) {
      if (row.phase === 'done' && row.sessionId && row.endedAt) done.set(row.sessionId, row.endedAt);
    }
    for (const d of readDecisions(root)) if (d.decision === 'confirmed') escaped.add(d.sessionId);
  }
  for (const e of fleet) {
    if (e.phase === 'done' && e.sessionId && e.updatedAt && !done.has(e.sessionId)) done.set(e.sessionId, e.updatedAt);
  }

  /** @type {Map<string, { month: string, done: number, escaped: number, rate: number, open: number }>} */
  const months = new Map();
  const total = { done: 0, escaped: 0, rate: 0, open: 0 };
  for (const [id, at] of done) {
    const month = at.slice(0, 7);
    if (!months.has(month)) months.set(month, { month, done: 0, escaped: 0, rate: 0, open: 0 });
    const m = /** @type {NonNullable<ReturnType<typeof months.get>>} */ (months.get(month));
    for (const bucket of [m, total]) {
      bucket.done += 1;
      if (escaped.has(id)) bucket.escaped += 1;
      if (now - Date.parse(at) < WINDOW_MS) bucket.open += 1;
    }
  }
  for (const bucket of [...months.values(), total]) bucket.rate = bucket.done ? bucket.escaped / bucket.done : 0;
  return {
    projects: [...roots],
    months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    total,
  };
}
