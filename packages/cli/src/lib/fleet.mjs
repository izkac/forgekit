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
 * Mirror a session into the registry. Never throws — a broken registry must
 * not break session saves.
 *
 * @param {string} projectRoot absolute project path
 * @param {Record<string, any>} session forge session.json contents
 */
export function registerSession(projectRoot, session) {
  try {
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
    };
    fs.mkdirSync(fleetDir(), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
  } catch {
    /* registry is advisory */
  }
}

export function unregisterSession(projectRoot, sessionId) {
  try {
    fs.rmSync(entryFile(projectRoot, sessionId), { force: true });
  } catch {
    /* advisory */
  }
}

/**
 * All registry entries, newest first. Self-heals: entries whose session dir
 * vanished (cleanup ran without unregister, project deleted the .forge dir)
 * are removed; entries whose whole project path is unreachable (unplugged
 * drive) are kept and marked `missing`.
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
