#!/usr/bin/env node
/**
 * Machine-level fleet registry: one JSON file per forge session under
 * `~/.forgekit/fleet/sessions/`, mirrored on every `saveSession` so any
 * project's sessions are visible from a single control terminal
 * (`forge fleet list|watch|view|send`).
 *
 * Standalone on purpose — no import of ../lib.mjs (which binds cwd at import
 * time); everything here takes explicit paths. `FORGEKIT_FLEET_DIR` overrides
 * the registry location (tests point it at a tmp dir).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { healSessionProgress } from '../plan-progress.mjs';

export const PHASE_ORDER = [
  'triage',
  'brainstorm',
  'plan',
  'implement',
  'verify',
  'review',
  'finish',
  'done',
];

export function fleetDir() {
  return (
    process.env.FORGEKIT_FLEET_DIR ||
    path.join(os.homedir(), '.forgekit', 'fleet', 'sessions')
  );
}

/** Same sanitisation Claude Code uses for ~/.claude/projects dir names. */
export function sanitizePath(p) {
  return String(p).replace(/[^a-zA-Z0-9]/g, '-');
}

export function entryFile(projectRoot, sessionId) {
  return path.join(fleetDir(), `${sanitizePath(projectRoot)}--${sessionId}.json`);
}

/**
 * Best-effort engine detection from env vars set by agent harnesses.
 * ponytail: claude + cursor only; other engines show as null until they
 * grow a detectable env marker.
 */
export function detectEngine(env = process.env) {
  if (env.CLAUDECODE) return 'claude';
  if (env.CURSOR_TRACE_ID || env.CURSOR_AGENT) return 'cursor';
  return null;
}

/**
 * Is this project root a scratch tree under the system temp dir?
 *
 * A real project is never there, and the unit suite's fixtures always are.
 * Compared as a path prefix rather than by string matching so that a project
 * legitimately named `/home/me/tmpfoo` is not caught, and resolved through
 * `realpathSync` because macOS hands out `/var/folders/...` paths whose
 * canonical form is `/private/var/folders/...`.
 *
 * @param {string} projectRoot
 * @returns {boolean}
 */
function underTempDir(projectRoot) {
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p); // does not exist yet; the literal path still tells us
    }
  };
  const rel = path.relative(real(os.tmpdir()), real(projectRoot));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Mirror a session into the registry. Never throws — a broken registry must
 * not break session saves.
 *
 * SCRATCH PROJECTS ARE NOT REGISTERED. The unit suite spawns real `forge`
 * processes against fixture projects under `os.tmpdir()`, and the only thing
 * keeping those out of the operator's registry was `FORGEKIT_FLEET_DIR` being
 * set by `scripts/run-tests.mjs`. Running a suite file directly with
 * `node --test` — which is what every Forge tier-2 command instructs — bypassed
 * it: measured on the author's machine, 8572 scratch entries against 10 real
 * ones, so `forge fleet report` was aggregating almost entirely dead `/tmp`
 * paths. The guard belongs here and not in the harness, because the harness is
 * the thing being bypassed. Same shape as F28, one layer down.
 *
 * @param {string} projectRoot absolute project path
 * @param {Record<string, any>} session forge session.json contents
 */
export function registerSession(projectRoot, session) {
  try {
    // Only the *default* registry is protected. `FORGEKIT_FLEET_DIR` means the
    // caller has already pointed the registry somewhere it owns — that is the
    // sandbox the fleet suite registers scratch projects into deliberately, to
    // exercise the registry at all. What must never happen is a fixture landing
    // in `~/.forgekit`, which is precisely the case where the variable is unset.
    if (!process.env.FORGEKIT_FLEET_DIR && underTempDir(projectRoot)) return;
    const file = entryFile(projectRoot, session.id);
    let prev = {};
    try {
      prev = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* first registration */
    }
    const entry = {
      project: projectRoot,
      projectName: path.basename(projectRoot),
      sessionId: session.id,
      slug: session.slug,
      phase: session.phase,
      planType: session.planType ?? null,
      openspecChange: session.openspecChange ?? null,
      tasksTotal: session.tasksTotal ?? 0,
      tasksComplete: session.tasksComplete ?? 0,
      pace: session.resolvedPace ?? session.pace ?? null,
      engine: detectEngine() ?? prev.engine ?? null,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastSeen: new Date().toISOString(),
    };
    fs.mkdirSync(fleetDir(), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
  } catch {
    /* registry is advisory */
  }
}

/**
 * Heartbeat: refresh lastSeen on an existing registry entry. Called from the
 * reminder hook, which fires on every agent turn — so lastSeen ≈ "agent is
 * actually running", unlike updatedAt which only moves on saveSession.
 */
export function touchSession(projectRoot, sessionId) {
  try {
    const file = entryFile(projectRoot, sessionId);
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    entry.lastSeen = new Date().toISOString();
    fs.writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
  } catch {
    /* advisory */
  }
}

// ponytail: fixed 30-min liveness window; make configurable if hooks ever fire slower.
export const LIVE_WINDOW_MS = 30 * 60 * 1000;

/**
 * Other live sessions in the same project — the overlap signal for "two
 * agents editing one working tree". Live = not done, session dir present,
 * heartbeat (lastSeen, falling back to updatedAt) within LIVE_WINDOW_MS.
 */
export function liveOverlaps(projectRoot, sessionId, now = Date.now()) {
  const root = path.resolve(projectRoot);
  return listFleet().filter((e) => {
    if (e.sessionId === sessionId || e.missing || e.phase === 'done') return false;
    if (path.resolve(e.project) !== root) return false;
    const seen = new Date(e.lastSeen ?? e.updatedAt).getTime();
    return !Number.isNaN(seen) && now - seen < LIVE_WINDOW_MS;
  });
}

export function unregisterSession(projectRoot, sessionId) {
  try {
    fs.rmSync(entryFile(projectRoot, sessionId), { force: true });
  } catch {
    /* advisory */
  }
}

/**
 * Fields the registry mirrors from session.json. `session.json` is the source
 * of truth; the entry is only a cache, so reads refresh it.
 */
const MIRRORED_FIELDS = [
  'slug',
  'phase',
  'planType',
  'openspecChange',
  'tasksTotal',
  'tasksComplete',
  'createdAt',
  'updatedAt',
];

/**
 * Refresh a cached entry from the session on disk. Returns true when anything
 * changed. A registry write that never happened (older CLI, a crash mid-run,
 * a hand-edited record) otherwise pins the entry at whatever phase it was
 * first registered with, forever.
 *
 * @param {Record<string, any>} entry
 * @param {string} sessionDir
 */
function reconcileEntry(entry, sessionDir) {
  let session;
  try {
    session = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'));
  } catch {
    return false; // unreadable/absent — keep the cached view
  }
  // tasks.md is authoritative for progress; heal the session cache when it
  // diverges so fleet/status/health stop lying about idle 0/N sessions.
  const healed = healSessionProgress({
    cwd: entry.project,
    sessionDir,
    session,
  });
  let changed = healed.changed;
  for (const key of MIRRORED_FIELDS) {
    const value = session[key];
    if (value === undefined) continue;
    if (entry[key] !== value) {
      entry[key] = value;
      changed = true;
    }
  }
  const pace = session.resolvedPace ?? session.pace ?? null;
  if (pace !== null && entry.pace !== pace) {
    entry.pace = pace;
    changed = true;
  }
  return changed;
}

/**
 * All registry entries, newest first. Self-heals: entries are reconciled
 * against each session.json on disk; entries whose session dir vanished
 * (cleanup ran without unregister, project deleted the .forge dir) are
 * removed; entries whose whole project path is unreachable (unplugged drive)
 * are kept and marked `missing`.
 *
 * @returns {Array<Record<string, any>>}
 */
export function listFleet() {
  const dir = fleetDir();
  if (!fs.existsSync(dir)) return [];
  const entries = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const sessionDir = path.join(entry.project, '.forge', 'sessions', entry.sessionId);
    if (fs.existsSync(sessionDir)) {
      // Persist before stamping `missing`, which is a view flag, not state.
      if (reconcileEntry(entry, sessionDir)) {
        try {
          fs.writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
        } catch {
          /* registry is advisory — a read-only registry still renders */
        }
      }
      entry.missing = false;
    } else if (fs.existsSync(entry.project)) {
      fs.rmSync(file, { force: true });
      continue;
    } else {
      entry.missing = true;
    }
    entries.push(entry);
  }
  entries.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return entries;
}

export function sessionDirFor(entry) {
  return path.join(entry.project, '.forge', 'sessions', entry.sessionId);
}

/**
 * Queue a fleet message for a session; delivered into the agent's context by
 * `forge reminder` (hook) on its next turn.
 */
export function queueMessage(sessionDir, message, from = 'fleet') {
  const inbox = path.join(sessionDir, 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const file = path.join(inbox, `${stamp}-${from}.md`);
  fs.writeFileSync(file, `${message}\n`, 'utf8');
  return file;
}

/**
 * Read-and-consume pending fleet messages (moved to inbox/delivered/ so each
 * is injected exactly once).
 *
 * @returns {Array<{ file: string, text: string }>}
 */
export function drainInbox(sessionDir) {
  const inbox = path.join(sessionDir, 'inbox');
  if (!fs.existsSync(inbox)) return [];
  const delivered = path.join(inbox, 'delivered');
  const out = [];
  for (const name of fs.readdirSync(inbox).sort()) {
    const file = path.join(inbox, name);
    if (!fs.statSync(file).isFile()) continue;
    const text = fs.readFileSync(file, 'utf8').trim();
    fs.mkdirSync(delivered, { recursive: true });
    fs.renameSync(file, path.join(delivered, name));
    out.push({ file: name, text });
  }
  return out;
}

/** Pending (undelivered) fleet messages, without consuming them. */
export function peekInbox(sessionDir) {
  const inbox = path.join(sessionDir, 'inbox');
  if (!fs.existsSync(inbox)) return [];
  return fs
    .readdirSync(inbox)
    .sort()
    .filter((name) => fs.statSync(path.join(inbox, name)).isFile())
    .map((name) => ({
      file: name,
      text: fs.readFileSync(path.join(inbox, name), 'utf8').trim(),
    }));
}

/**
 * Claude Code transcript dir for a project (`~/.claude/projects/<sanitized>`),
 * or null when absent.
 */
export function claudeTranscriptDir(projectRoot, home = os.homedir()) {
  const dir = path.join(home, '.claude', 'projects', sanitizePath(projectRoot));
  return fs.existsSync(dir) ? dir : null;
}

/** Newest transcript jsonl in a project's Claude dir, or null. */
export function newestTranscript(projectRoot, home = os.homedir()) {
  const dir = claudeTranscriptDir(projectRoot, home);
  if (!dir) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const full = path.join(dir, f);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.full ?? null;
}
