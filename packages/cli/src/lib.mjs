#!/usr/bin/env node
/**
 * Shared helpers for Forge session management.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { registerSession } from './lib/fleet.mjs';
import { findRepoRoot } from './repo-root.mjs';

export { findRepoRoot };

export const REPO_ROOT = findRepoRoot();
export const FORGE_DIR = path.join(REPO_ROOT, '.forge');
export const SESSIONS_DIR = path.join(FORGE_DIR, 'sessions');
export const ACTIVE_FILE = path.join(FORGE_DIR, 'active.json');
export const RETENTION_DAYS = 14;

export function ensureForgeLayout() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

export function slugify(input) {
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'session';
}

export function utcCompactNow() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function randomSuffix(bytes = 3) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function makeSessionId(slug) {
  return `${utcCompactNow()}-${slugify(slug)}-${randomSuffix()}`;
}

export function sessionPath(sessionId) {
  return path.join(SESSIONS_DIR, sessionId);
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function readActive() {
  if (!fs.existsSync(ACTIVE_FILE)) return null;
  try {
    return readJson(ACTIVE_FILE);
  } catch {
    return null;
  }
}

export function writeActive(sessionId) {
  writeJson(ACTIVE_FILE, {
    sessionId,
    sessionPath: path.relative(REPO_ROOT, sessionPath(sessionId)).replace(/\\/g, '/'),
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Every session in this project that could still be the one being worked on.
 *
 * `null` means the directory could not be enumerated — which is not the same as
 * finding nothing in it, and a caller must never read it as "one session, no
 * ambiguity". Only a *missing* `session.json` means a directory is not a
 * session; unreadable, truncated or permission-denied is a session we could not
 * judge, and it is returned marked `unreadable` so the caller can say so.
 *
 * @returns {{ id: string, slug?: string, phase?: string, unreadable?: boolean }[] | null}
 */
export function unfinishedSessions() {
  /** @type {{ id: string, slug?: string, phase?: string, unreadable?: boolean }[]} */
  const out = [];
  /** @type {string[]} */
  let names;
  try {
    names = fs.readdirSync(SESSIONS_DIR);
  } catch (err) {
    if (err?.code === 'ENOENT') return out; // no sessions dir: nothing to be ambiguous about
    return null;
  }
  for (const name of names) {
    /** @type {Record<string, any>} */
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, name, 'session.json'), 'utf8'));
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      out.push({ id: name, unreadable: true });
      continue;
    }
    if (raw?.phase === 'done' || raw?.phase === 'skipped') continue;
    out.push({ id: raw?.id ?? name, slug: raw?.slug, phase: raw?.phase });
  }
  return out;
}

/**
 * Which session a command should act on when the operator did not name one.
 *
 * THE ONE PLACE THIS IS DECIDED. It used to be decided independently wherever a
 * command needed a session — `readActive()` has a dozen importers — and each
 * one trusted the pointer differently. `active.json` was written only by
 * `forge new`, so "active" meant *most recently created*, and every command
 * that resolved without being told answered for the wrong change: the label
 * named a neighbour, `forge status` agreed with it, and `forge phase done` —
 * the money/auth gate — ran against the neighbour while the high-risk change it
 * was supposed to judge ended with no verdict, no scorecard and no ledger line
 * at all. Eight review rounds each found this at a different call site, because
 * each fix landed where the reproduction was written rather than where the
 * decision lives.
 *
 * The rules, in order:
 *   - an explicitly named session wins, always
 *   - if the sessions directory cannot be read, refuse — inability to look is
 *     never "there is only one"
 *   - if more than one session is unfinished, refuse and name them; guessing
 *     between them is silent and fails open at the gate
 *   - prefer the pointer when it names an unfinished session, otherwise the one
 *     session still open — a pointer naming finished work must not win over
 *     work in progress
 *
 * Never throws. `id` is null exactly when `problem` is set.
 *
 * @param {string | null | undefined} explicit a `--session` argument
 * @returns {{ id: string | null, from: 'flag' | 'active' | 'only-open' | 'none',
 *   problem?: string, candidates?: { id: string, slug?: string, phase?: string, unreadable?: boolean }[] }}
 */
export function resolveSessionId(explicit) {
  if (typeof explicit === 'string' && explicit) return { id: explicit, from: 'flag' };

  const candidates = unfinishedSessions();
  if (candidates === null) {
    return {
      id: null,
      from: 'none',
      problem: `could not read ${SESSIONS_DIR} to tell which session to act on`,
    };
  }
  if (candidates.length > 1) {
    return {
      id: null,
      from: 'none',
      problem: `${candidates.length} sessions are unfinished in this project`,
      candidates,
    };
  }

  const active = readActive()?.sessionId ?? null;
  if (active !== null && candidates.some((c) => c.id === active)) {
    return { id: active, from: 'active' };
  }
  if (candidates.length === 1) return { id: candidates[0].id, from: 'only-open' };
  return active === null ? { id: null, from: 'none' } : { id: active, from: 'active' };
}

/**
 * The refusal text for a `resolveSessionId` that could not decide, phrased the
 * same way wherever it is printed.
 *
 * @param {ReturnType<typeof resolveSessionId>} resolved
 * @param {string} command e.g. `forge phase done`
 * @returns {string}
 */
export function sessionAmbiguityMessage(resolved, command) {
  const lines = [`Refusing to guess which session to act on — ${resolved.problem}.`];
  for (const c of resolved.candidates ?? []) {
    lines.push(
      `  --session ${c.id}` +
        (c.unreadable
          ? '   (session.json unreadable — cannot tell whether it is finished)'
          : c.slug
            ? `   (${c.slug}, ${c.phase ?? 'no phase'})`
            : ''),
    );
  }
  lines.push('', `Re-run naming one, e.g. ${command} --session <id>.`);
  lines.push('Acting on the wrong session credits its review to the wrong change,');
  lines.push('and that passes the money/auth floor silently.');
  return `${lines.join('\n')}\n`;
}

export function clearActive() {
  if (fs.existsSync(ACTIVE_FILE)) fs.unlinkSync(ACTIVE_FILE);
}

export function defaultSession(sessionId, slug) {
  const now = new Date().toISOString();
  return {
    id: sessionId,
    slug: slugify(slug),
    createdAt: now,
    updatedAt: now,
    phase: 'triage',
    planType: null,
    openspecChange: null,
    forgeSkipped: false,
    cursorChatId: null,
    tasksTotal: 0,
    tasksComplete: 0,
    /** Requested pace: auto | thorough | standard | brisk | lite */
    pace: 'auto',
    /** Concrete pace after auto resolve or explicit pin */
    resolvedPace: null,
    paceReason: null,
    paceSignal: null,
    pacePinned: false,
    preferencesOverride: null,
    /** Host agent binding, filled by bindHost() — see metrics/host.mjs */
    host: null,
    /** Chronological {phase, at} trail, appended to on every transition */
    phaseHistory: [],
  };
}

/**
 * Record a phase transition on the session's timeline.
 *
 * The trail exists so telemetry can attribute host requests to the phase they
 * were spent in — it is the join key, so the timestamps are real transition
 * times and earlier rows are never rewritten. Re-entering the same phase is
 * not a transition: `forge phase implement --tasks-complete N` runs after
 * every task, and a row per run would bury the shape of the session.
 *
 * Lives here rather than in set-phase.mjs because `forge new` seeds the first
 * row and `forge phase` appends the rest, and set-phase.mjs is a script that
 * runs the CLI on import — importing it from new-session.mjs exits 1.
 *
 * @param {Record<string, any>} session
 * @param {string} phase
 * @param {string} at ISO timestamp
 * @returns {Record<string, any>} the same session object
 */
export function appendPhaseHistory(session, phase, at) {
  if (!Array.isArray(session.phaseHistory)) session.phaseHistory = [];
  const last = session.phaseHistory[session.phaseHistory.length - 1];
  if (last && last.phase === phase) return session;
  session.phaseHistory.push({ phase, at });
  return session;
}

export function defaultStatus(session) {
  return {
    sessionId: session.id,
    phase: session.phase,
    planType: session.planType,
    openspecChange: session.openspecChange,
    tasksTotal: session.tasksTotal,
    tasksComplete: session.tasksComplete,
    pace: session.pace ?? null,
    resolvedPace: session.resolvedPace ?? null,
    paceReason: session.paceReason ?? null,
    updatedAt: session.updatedAt,
  };
}

export function scaffoldSessionDirs(dir) {
  for (const sub of ['brainstorm', 'tasks', 'reviews']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
}

export function loadSession(sessionId) {
  const dir = sessionPath(sessionId);
  const file = path.join(dir, 'session.json');
  if (!fs.existsSync(file)) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  return { dir, session: readJson(file) };
}

export function saveSession(dir, session) {
  session.updatedAt = new Date().toISOString();
  writeJson(path.join(dir, 'session.json'), session);
  writeJson(path.join(dir, 'status.json'), defaultStatus(session));
  // Mirror into ~/.forgekit/fleet so `forge fleet` sees every project's
  // sessions. Project root derived from dir (<root>/.forge/sessions/<id>),
  // not REPO_ROOT, so callers with explicit dirs mirror correctly too.
  registerSession(path.resolve(dir, '..', '..', '..'), session);
}

/**
 * Age of a session in days, for retention. Legacy and hand-written records
 * carry `startedAt` (or nothing) instead of `createdAt`; an undatable record
 * counts as **infinitely old** rather than brand new — `new Date(undefined)`
 * is NaN and `NaN > RETENTION_DAYS` is false, which let abandoned sessions
 * survive every cleanup run forever.
 *
 * @param {Record<string, any>} session
 * @returns {number} days, or Infinity when no date can be read
 */
export function sessionAgeDays(session) {
  for (const value of [session?.createdAt, session?.startedAt, session?.updatedAt]) {
    if (!value) continue;
    const at = new Date(value).getTime();
    if (!Number.isNaN(at)) return (Date.now() - at) / (1000 * 60 * 60 * 24);
  }
  return Infinity;
}
