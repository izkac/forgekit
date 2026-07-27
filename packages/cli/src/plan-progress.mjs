#!/usr/bin/env node
/**
 * Plan task progress — tasks.md checkboxes are the source of truth.
 *
 * Agents tick OpenSpec/specs `tasks.md`; session.tasksComplete is a cache that
 * drifts when they forget `forge phase --tasks-complete`. Fleet/status/health
 * must read the plan file (and heal the cache) instead of trusting the mirror.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveChangeDir } from './integrity.mjs';

/** A tasks.md checkbox line; capture group 1 is the mark (` ` / `x` / `X`). */
const TASK_LINE_RE = /^\s*-\s*\[([ xX])\]\s+/;

/**
 * @param {string} body
 * @returns {{ total: number, complete: number }}
 */
export function countTasksMdCheckboxes(body) {
  let total = 0;
  let complete = 0;
  for (const line of String(body ?? '').split('\n')) {
    const m = TASK_LINE_RE.exec(line);
    if (!m) continue;
    total += 1;
    if (m[1] !== ' ') complete += 1;
  }
  return { total, complete };
}

/**
 * @param {{ cwd?: string, session: Record<string, any> }} opts
 * @returns {{ total: number, complete: number, mtimeMs: number, changeDir: string, path: string } | null}
 */
export function readPlanTaskProgress(opts) {
  const cwd = opts.cwd ?? process.cwd();
  const changeDir = resolveChangeDir({ cwd, session: opts.session });
  if (!changeDir) return null;
  const file = path.join(changeDir, 'tasks.md');
  if (!fs.existsSync(file)) return null;
  let body;
  let mtimeMs;
  try {
    body = fs.readFileSync(file, 'utf8');
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const { total, complete } = countTasksMdCheckboxes(body);
  if (total === 0) return null;
  return { total, complete, mtimeMs, changeDir, path: file };
}

/**
 * Overlay plan checkbox counts onto a session object. Does not persist.
 *
 * @param {Record<string, any>} session
 * @param {{ total: number, complete: number } | null | undefined} progress
 * @returns {boolean} true when session fields changed
 */
export function overlayPlanProgress(session, progress) {
  if (!session || !progress || progress.total <= 0) return false;
  let changed = false;
  if (Number(session.tasksTotal) !== progress.total) {
    session.tasksTotal = progress.total;
    changed = true;
  }
  if (Number(session.tasksComplete) !== progress.complete) {
    session.tasksComplete = progress.complete;
    changed = true;
  }
  return changed;
}

/**
 * Heal session.json (+ status.json) when tasks.md diverges from the cache.
 * Avoids importing saveSession (circular with fleet registry).
 *
 * @param {{ cwd?: string, sessionDir: string, session: Record<string, any>, now?: number }} opts
 * @returns {{ changed: boolean, progress: ReturnType<typeof readPlanTaskProgress> }}
 */
export function healSessionProgress(opts) {
  const cwd = opts.cwd ?? process.cwd();
  const { sessionDir, session } = opts;
  const progress = readPlanTaskProgress({ cwd, session });
  if (!overlayPlanProgress(session, progress)) {
    return { changed: false, progress };
  }
  const nowIso = new Date(opts.now ?? Date.now()).toISOString();
  session.updatedAt = nowIso;
  try {
    fs.writeFileSync(
      path.join(sessionDir, 'session.json'),
      `${JSON.stringify(session, null, 2)}\n`,
      'utf8',
    );
    const statusPath = path.join(sessionDir, 'status.json');
    if (fs.existsSync(statusPath)) {
      let status = {};
      try {
        status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      } catch {
        status = {};
      }
      status.tasksTotal = session.tasksTotal;
      status.tasksComplete = session.tasksComplete;
      status.updatedAt = nowIso;
      status.phase = session.phase;
      fs.writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
    }
  } catch {
    /* heal is advisory — callers still use in-memory overlay */
  }
  return { changed: true, progress };
}
