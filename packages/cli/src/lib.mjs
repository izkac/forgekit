#!/usr/bin/env node
/**
 * Shared helpers for Forge session management.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isTerminalPhase, registerSession } from './lib/fleet.mjs';
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

/**
 * Write JSON so a concurrent reader sees the old file or the new one, never a
 * half-written one.
 *
 * `writeFileSync` truncates and *then* writes, so a reader landing between the
 * two gets an empty or partial file. Measured with two concurrent writer
 * processes: **62 torn reads in 79** on a plain write, **0** over a rename.
 * (A single-process probe reports 0 for both and proves nothing — reads and
 * writes never interleave in one thread.)
 *
 * That was tolerable while these files were written once per command.
 * `active.json` is now written on every phase transition, and a torn read of
 * *it* costs real guards: `forge cleanup` loses the live-session check that
 * stops it deleting work in progress, and the SessionStart hook tells the next
 * agent there is no session at all.
 *
 * Rename within the same directory is atomic on POSIX and on Windows for a
 * same-volume replace. A failed rename cleans up its temp file and rethrows;
 * callers already treat a failed write as advisory.
 */
export function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // best effort — the write already failed
    }
    throw err;
  }
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
 * @param {string} [sessionsDir] defaults to this checkout's `.forge/sessions`;
 *   passed explicitly by callers that take their own `cwd`
 * @returns {{ id: string, declaredId?: string | null, slug?: string, phase?: string, unreadable?: boolean }[] | null}
 *   `id` is the directory name — the key `loadSession` and `--session` address by
 */
export function unfinishedSessions(sessionsDir = SESSIONS_DIR) {
  /** @type {{ id: string, declaredId?: string | null, slug?: string, phase?: string, unreadable?: boolean }[]} */
  const out = [];
  /** @type {string[]} */
  let names;
  try {
    names = fs.readdirSync(sessionsDir);
  } catch (err) {
    if (err?.code === 'ENOENT') return out; // no sessions dir: nothing to be ambiguous about
    return null;
  }
  for (const name of names) {
    /** @type {Record<string, any>} */
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(sessionsDir, name, 'session.json'), 'utf8'));
    } catch (err) {
      // WHAT COUNTS AS "NOT A SESSION" IS THE ABSENCE OF ITS session.json, and
      // nothing else. An earlier version asked the dirent whether it was a
      // directory — a check copied from `cleanup-sessions.mjs`, where skipping
      // means *don't delete* and is therefore safe, into here, where skipping
      // means *don't count* and hides a session from the gate. A symlinked
      // session directory is not `isDirectory()`, so it went invisible and
      // `forge phase done` acted on the pointer with no warning at all.
      //
      // ENOENT is "no session here" (a stray `.DS_Store` gives ENOTDIR on the
      // join, which is the same answer). Anything else is a session we could
      // not read, and that is a candidate, not a silence.
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') continue;
      out.push({ id: name, unreadable: true });
      continue;
    }
    if (isTerminalPhase(raw?.phase)) continue;
    // THE DIRECTORY NAME IS THE ADDRESSABLE KEY. `loadSession` resolves
    // `SESSIONS_DIR/<id>`, `--session` is passed straight to it, and
    // `active.json` stores the same thing — so returning the *declared*
    // `session.json` id made every consumer address a path that need not
    // exist. Reproduced: a session whose declared id differs from its directory
    // crashed `forge status` with an uncaught "Session not found", and the
    // remedy the gate printed crashed the same way.
    out.push({ id: name, declaredId: raw?.id ?? null, slug: raw?.slug, phase: raw?.phase });
  }
  return out;
}

/**
 * Which session a command should act on when the operator did not name one.
 *
 * THE ONE PLACE THIS IS DECIDED. It used to be decided independently wherever a
 * command needed a session — `readActive()` has a dozen importers — and each one
 * trusted the pointer differently. `active.json` was written only by `forge
 * new`, so "active" meant *most recently created*, and every command that
 * resolved without being told answered for the wrong change: the label named a
 * neighbour, `forge status` agreed with it, and `forge phase done` — the
 * money/auth gate — ran against the neighbour while the high-risk change it was
 * supposed to judge ended with no verdict, no scorecard and no ledger line.
 *
 * IT REPORTS AMBIGUITY; IT DOES NOT PRICE IT. `ambiguous` says the answer rests
 * on a pointer that is only a hint, and `candidates` says what else it could
 * have been — but what that *costs* depends entirely on the caller. Acting on
 * the wrong session at `implement` costs a re-run; at `done` it writes a
 * permanent scorecard and ledger line for the wrong change and skips the
 * money/auth floor for the right one. A resolver that refused for both would be
 * an obstruction; one that guessed for both is the bug. So it hands back what
 * it knows and lets `set-phase.mjs` decide.
 *
 * `id` is null only when there is no defensible answer at all: the sessions
 * directory could not be read, or several are open and the pointer names none
 * of them.
 *
 * Never throws.
 *
 * @param {string | null | undefined} explicit a `--session` argument
 * @returns {{ id: string | null, from: 'flag' | 'active' | 'only-open' | 'none',
 *   ambiguous?: boolean, problem?: string,
 *   candidates?: { id: string, declaredId?: string | null, slug?: string, phase?: string, unreadable?: boolean }[] }}
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

  const active = readActive()?.sessionId ?? null;
  const activeIsOpen = active !== null && candidates.some((c) => c.id === active);

  if (candidates.length > 1) {
    // The pointer is the only signal left, and it is a weak one — it moves when
    // a session is created, not when one is worked on. Good enough to act on
    // for a reversible phase, never good enough to gate on.
    return activeIsOpen
      ? { id: active, from: 'active', ambiguous: true, candidates }
      : {
          id: null,
          from: 'none',
          ambiguous: true,
          candidates,
          problem: `${candidates.length} sessions are unfinished and .forge/active.json names none of them`,
        };
  }

  if (activeIsOpen) return { id: active, from: 'active' };
  // A pointer naming finished work must not beat the one session still open.
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
  const lines = [
    resolved.problem
      ? `Refusing to guess which session to act on — ${resolved.problem}.`
      : `Refusing to guess which session to act on — ${resolved.candidates?.length ?? 0} are unfinished in this project.`,
  ];
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

/**
 * Resolve the session a command acts on, or exit — the whole policy in one call.
 *
 * `strict` is the operator's severity choice, and the line it draws is
 * *recoverability*, not importance. A command that writes a permanent record or
 * destroys one cannot be un-run against the wrong session: `forge phase
 * done|finish` files a scorecard and a durable ledger line and decides the
 * money/auth verdict, `forge checkpoint` makes a commit, `forge cleanup`
 * deletes session directories. Those refuse. Everything else says which session
 * it picked and carries on, because being wrong there costs a re-run and
 * refusing would block ordinary work in any project with two sessions open.
 *
 * @param {string | null | undefined} explicit a `--session` argument
 * @param {{ command: string, strict?: boolean }} opts
 * @returns {string}
 */
export function resolveSessionOrExit(explicit, { command, strict = false }) {
  const resolved = resolveSessionId(explicit);
  if (resolved.id === null) {
    process.stderr.write(
      resolved.problem || resolved.ambiguous
        ? sessionAmbiguityMessage(resolved, command)
        : 'No active session. Run forge new first.\n',
    );
    process.exit(1);
  }
  if (resolved.ambiguous) {
    if (strict) {
      process.stderr.write(sessionAmbiguityMessage(resolved, command));
      process.exit(1);
    }
    const others = (resolved.candidates ?? [])
      .filter((c) => c.id !== resolved.id)
      .map((c) => `  --session ${c.id}${c.slug ? `   (${c.slug}, ${c.phase ?? 'no phase'})` : ''}`);
    process.stderr.write(
      `[forge] Warning: ${resolved.candidates?.length ?? 0} sessions are unfinished; ` +
        `acting on ${resolved.id} (from .forge/active.json).\n` +
        `[forge] To act on another instead:\n${others.join('\n')}\n`,
    );
  }
  return resolved.id;
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

/**
 * F89: a verify-evidence BLOCKED marker must own its line — a line starting
 * with `BLOCKED` (optionally a Markdown heading like `## BLOCKED`). Plain
 * `\bBLOCKED\b` matched mid-sentence prose ("the subagent reported BLOCKED
 * in its status") and failed the done gate on a mention, not a marker; this
 * is the same whole-line discipline the no-tdd marker got after its
 * smuggling finding.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasBlockedMarker(text) {
  return /^[ \t]*(?:#{1,6}[ \t]+)?BLOCKED\b/m.test(String(text || ''));
}
