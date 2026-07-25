#!/usr/bin/env node
/**
 * Durable session ledgers.
 *
 * `cleanup-sessions` deletes the whole session dir at done, so reviews,
 * deferrals, fix-round briefs and test evidence all disappear — 5 of 6 scored
 * sessions in one project were already gone, and what the reviews actually
 * caught survived nowhere. `scorecards.jsonl` solved exactly this problem for
 * scores; these are the same trick for the rest:
 *
 *   .forge/sessions.jsonl    one digest line per finished session
 *   .forge/deferrals.jsonl   unresolved deferrals, with the session that owed them
 *
 * Both are append-with-replace (keyed by sessionId), tolerant of corrupt
 * lines, and never throw — a ledger must not block a phase transition.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadDeferrals } from './integrity.mjs';
import { reviewCensus } from './review-census.mjs';
import { sessionHealth } from './health.mjs';

/**
 * @param {string} file
 * @returns {Record<string, any>[]}
 */
export function readLedger(file) {
  if (!fs.existsSync(file)) return [];
  /** @type {Record<string, any>[]} */
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A half-written line from a killed process must not hide the rest.
    }
  }
  return out;
}

/**
 * @param {string} file
 * @param {Record<string, any>[]} lines
 * @param {(entry: Record<string, any>) => boolean} [replaceWhen] existing entries matching this are dropped
 */
function appendLines(file, lines, replaceWhen) {
  if (lines.length === 0) return 0;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const kept = replaceWhen ? readLedger(file).filter((e) => !replaceWhen(e)) : readLedger(file);
    const all = [...kept, ...lines].map((e) => JSON.stringify(e));
    fs.writeFileSync(file, `${all.join('\n')}\n`, 'utf8');
    return lines.length;
  } catch {
    return 0; // advisory
  }
}

/** @param {{ cwd?: string }} opts */
function forgeDirOf(opts, sessionDir) {
  return opts.cwd ? path.join(opts.cwd, '.forge') : path.resolve(sessionDir, '..', '..');
}

/**
 * One line summarising how a session actually went — the fields a later
 * analysis would otherwise have to reconstruct from deleted directories.
 *
 * @param {{ cwd?: string, sessionDir: string, session: Record<string, any>, card?: Record<string, any> | null }} opts
 */
export function appendSessionDigest(opts) {
  const { sessionDir, session } = opts;
  try {
    const census = reviewCensus(sessionDir);
    const health = sessionHealth({ cwd: opts.cwd, sessionDir, session });
    const started = new Date(session.createdAt ?? NaN).getTime();
    const ended = new Date(session.updatedAt ?? NaN).getTime();
    const durationHours =
      Number.isNaN(started) || Number.isNaN(ended)
        ? null
        : Math.round(((ended - started) / 3600000) * 100) / 100;

    const entry = {
      sessionId: session.id ?? null,
      slug: session.slug ?? null,
      change: session.openspecChange ?? null,
      phase: session.phase ?? null,
      planType: session.planType ?? null,
      pace: session.resolvedPace ?? session.pace ?? null,
      tasks: `${session.tasksComplete ?? 0}/${session.tasksTotal ?? 0}`,
      subagentsDispatched: session.subagentsDispatched ?? null,
      reviews: {
        total: census.total,
        independent: census.independent,
        selfChecks: census.selfChecks,
        rejections: census.rejections,
        final: census.finalReview,
      },
      checkpoints: Array.isArray(session.checkpoints) ? session.checkpoints.length : 0,
      health: health.state,
      healthReasons: health.reasons,
      score: opts.card?.score ?? session.score ?? null,
      grade: opts.card?.grade ?? session.scoreGrade ?? null,
      incompleteReason: session.incompleteReason ?? null,
      durationHours,
      startedAt: session.createdAt ?? null,
      endedAt: session.updatedAt ?? null,
    };
    return appendLines(
      path.join(forgeDirOf(opts, sessionDir), 'sessions.jsonl'),
      [entry],
      (e) => e.sessionId === entry.sessionId,
    );
  } catch {
    return 0;
  }
}

/**
 * Unresolved deferrals, promoted out of the session before it is deleted.
 * Resolved ones are not debt and are left behind.
 *
 * @param {{ cwd?: string, sessionDir: string, session: Record<string, any> }} opts
 */
export function appendDeferralLedger(opts) {
  const { sessionDir, session } = opts;
  try {
    const doc = loadDeferrals(sessionDir);
    const open = (doc?.deferrals ?? []).filter((d) => d && !d.resolvedAt);
    const lines = open.map((d) => ({
      sessionId: session.id ?? null,
      slug: session.slug ?? null,
      change: session.openspecChange ?? null,
      task: d.task ?? null,
      reason: d.reason ?? null,
      createdAt: d.createdAt ?? null,
      carriedAt: new Date().toISOString(),
    }));
    return appendLines(
      path.join(forgeDirOf(opts, sessionDir), 'deferrals.jsonl'),
      lines,
      (e) => e.sessionId === (session.id ?? null),
    );
  } catch {
    return 0;
  }
}
