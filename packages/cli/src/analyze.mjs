/**
 * Read the durable ledgers back as numbers.
 *
 * Forge writes three things that outlive a session: `sessions.jsonl` (one
 * digest line per finished session), `scorecards.jsonl` (how disciplined it
 * was) and, while the session directory still exists, the full `metrics.json`.
 * This module joins them into one answer to "how are the workflow and the
 * models actually doing".
 *
 * TWO TIERS OF EVIDENCE, and the difference is the point. A digest survives
 * `forge cleanup` and carries totals plus compact `byModel` / `byPhase`
 * splits (when the session finished after that schema landed). The live
 * `metrics.json` is preferred when still on disk — freshest, and it still
 * holds tool tables and error counts the digest does not. When only the
 * digest remains, its splits fill per-model and per-phase request/token
 * rows. Sessions that predate digest splits still contribute model *names*
 * and grades from the digest, with `detailed` counting only sessions that
 * actually contributed a split. A row claiming fewer tokens than were really
 * spent is far worse than one that admits how much of its history it can
 * still see.
 *
 * COVERAGE IS STATED FIRST for the same reason. A project six of whose nine
 * sessions predate telemetry has a real answer and a partial one, and the
 * partial one is dangerous only if it is read as complete.
 *
 * Deterministic and read-only by contract: no timestamps in the output, no
 * files touched, same ledgers in → same object out. `/forge:analyze` owns the
 * narrative report and consumes this; two writers would compete for it.
 */

import fs from 'node:fs';
import path from 'node:path';

import { readLedger } from './ledger.mjs';

const TOKEN_FIELDS = ['input', 'output', 'cacheRead', 'cacheCreate'];

/** @param {unknown} value */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * A session's full metrics document, if its directory outlived it.
 *
 * @param {string} forgeDir
 * @param {unknown} sessionId
 * @returns {Record<string, any> | null}
 */
function readSessionDoc(forgeDir, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  try {
    const doc = JSON.parse(
      fs.readFileSync(path.join(forgeDir, 'sessions', sessionId, 'metrics.json'), 'utf8'),
    );
    return doc && typeof doc === 'object' ? doc : null;
  } catch {
    return null; // pruned, unreadable or corrupt — the digest still stands
  }
}

/**
 * Order a history newest-first, deterministically.
 *
 * `endedAt` is the natural key but is null on sessions that never finished and
 * absent on old lines, so `startedAt` is the fallback and `sessionId` — which
 * begins with a compact UTC stamp — is the final tie-break. Two runs over the
 * same ledger must not disagree about the order.
 *
 * @param {Record<string, any>} entry
 */
function orderKey(entry) {
  const at = Date.parse(entry?.endedAt ?? entry?.startedAt ?? '');
  return Number.isNaN(at) ? -Infinity : at;
}

/**
 * `since` as epoch milliseconds, or null when it cannot be used as a filter.
 *
 * An unusable value is ignored rather than fatal: this command is read-only
 * and its worst failure should be showing too much, not refusing to run.
 *
 * @param {unknown} since
 */
function sinceMs(since) {
  if (typeof since !== 'string' || !since.trim()) return null;
  const ms = Date.parse(since);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Aggregate the ledgers into one deterministic analysis.
 *
 * @param {{ cwd?: string, limit?: number, since?: string }} [options]
 * @returns {Record<string, any>}
 */
export function buildAnalysis(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const forgeDir = path.join(opts.cwd ?? process.cwd(), '.forge');

  /** @type {Map<string, Record<string, any>>} */
  const cards = new Map();
  for (const card of readLedger(path.join(forgeDir, 'scorecards.jsonl'))) {
    if (typeof card?.sessionId === 'string') cards.set(card.sessionId, card);
  }

  let digests = readLedger(path.join(forgeDir, 'sessions.jsonl')).filter(
    (entry) => entry && typeof entry === 'object',
  );
  digests.sort((a, b) => orderKey(b) - orderKey(a) || String(b.sessionId).localeCompare(String(a.sessionId)));

  const from = sinceMs(opts.since);
  if (from !== null) digests = digests.filter((entry) => orderKey(entry) >= from);
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : null;
  if (limit !== null) digests = digests.slice(0, limit);

  /** @type {Record<string, any>} */
  const byModel = Object.create(null);
  /** @type {Record<string, any>} */
  const byPhase = Object.create(null);
  /** @type {Record<string, number>} */
  const grades = Object.create(null);
  const dispatches = { total: 0, allowed: 0, rewritten: 0, denied: 0, skipped: 0, sessions: 0 };
  const totals = { requests: 0, outputTokens: 0, totalTokens: 0, subagents: 0 };
  /** @type {Record<string, any>[]} */
  const sessions = [];
  let toolResults = 0;
  let errorResults = 0;
  let withMetrics = 0;

  for (const entry of digests) {
    const card = cards.get(entry.sessionId) ?? null;
    const compact = entry.metrics && typeof entry.metrics === 'object' ? entry.metrics : null;
    const hasMetrics = compact?.available === true;
    const doc = readSessionDoc(forgeDir, entry.sessionId);
    const grade = entry.grade ?? card?.grade ?? null;

    if (hasMetrics) {
      withMetrics += 1;
      totals.requests += num(compact.requests);
      totals.outputTokens += num(compact.outputTokens);
      totals.totalTokens += num(compact.totalTokens);
      totals.subagents += num(compact.subagents);
    }
    if (typeof grade === 'string' && grade) grades[grade] = (grades[grade] ?? 0) + 1;

    // Prefer live metrics.json splits; else digest compact byModel/byPhase.
    // Name-only historical digests still contribute sessions/grades only.
    const live = doc?.available === true;
    const modelSplit = live
      ? doc.byModel && typeof doc.byModel === 'object'
        ? doc.byModel
        : null
      : compact?.byModel && typeof compact.byModel === 'object'
        ? compact.byModel
        : null;
    const phaseSplit = live
      ? doc.byPhase && typeof doc.byPhase === 'object'
        ? doc.byPhase
        : null
      : compact?.byPhase && typeof compact.byPhase === 'object'
        ? compact.byPhase
        : null;
    const named = modelSplit
      ? Object.keys(modelSplit)
      : Array.isArray(compact?.models)
        ? compact.models
        : [];
    for (const model of named) {
      if (typeof model !== 'string' || !model || model === '<synthetic>') continue;
      const row = (byModel[model] ??= {
        sessions: 0,
        detailed: 0,
        requests: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreate: 0,
        toolResults: 0,
        errorResults: 0,
        sessionErrorRate: 0,
        grades: [],
      });
      row.sessions += 1;
      if (typeof grade === 'string' && grade) row.grades.push(grade);
      if (!modelSplit) continue;
      row.detailed += 1;
      const cell = modelSplit[model] ?? {};
      row.requests += num(cell.requests);
      for (const field of TOKEN_FIELDS) row[field] += num(cell[field]);
      // The host does not attribute a tool result to a model, so a model's
      // error rate can only be the rate of the sessions it ran in. Named
      // `sessionErrorRate` so nobody reads it as anything sharper. Only a
      // live document carries the raw tool/error counts.
      if (live) {
        row.toolResults += num(doc.errors?.toolResults);
        row.errorResults += num(doc.errors?.errorResults);
      }
    }

    if (phaseSplit) {
      for (const [phase, cell] of Object.entries(phaseSplit)) {
        const row = (byPhase[phase] ??= {
          sessions: 0,
          requests: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheCreate: 0,
        });
        row.sessions += 1;
        row.requests += num(cell?.requests);
        for (const field of TOKEN_FIELDS) row[field] += num(cell?.[field]);
      }
    }
    if (live) {
      toolResults += num(doc.errors?.toolResults);
      errorResults += num(doc.errors?.errorResults);
    }

    // Prefer the document, fall back to the digest's own copy — which is the
    // only one left once `forge cleanup` has run.
    const table = (live ? doc.dispatches : null) ?? entry.dispatches ?? null;
    if (table && typeof table === 'object') {
      dispatches.sessions += 1;
      for (const key of ['total', 'allowed', 'rewritten', 'denied', 'skipped']) {
        dispatches[key] += num(table[key]);
      }
    }

    sessions.push({
      sessionId: entry.sessionId ?? null,
      slug: entry.slug ?? null,
      change: entry.change ?? null,
      phase: entry.phase ?? null,
      pace: entry.pace ?? null,
      tasks: entry.tasks ?? null,
      score: entry.score ?? card?.score ?? null,
      grade,
      health: entry.health ?? null,
      durationHours: entry.durationHours ?? null,
      endedAt: entry.endedAt ?? null,
      hasMetrics,
      detailed: live,
      requests: hasMetrics ? num(compact.requests) : null,
      outputTokens: hasMetrics ? num(compact.outputTokens) : null,
      totalTokens: hasMetrics ? num(compact.totalTokens) : null,
      errorRate: hasMetrics ? num(compact.errorRate) : null,
      subagents: entry.subagentsDispatched ?? (hasMetrics ? num(compact.subagents) : null),
      models: Array.isArray(compact?.models) ? compact.models : [],
      dispatchesSkipped: entry.dispatchesSkipped ?? (table ? num(table.skipped) : null),
    });
  }

  for (const row of Object.values(byModel)) {
    row.sessionErrorRate = row.toolResults > 0 ? row.errorResults / row.toolResults : 0;
    row.grades.sort();
  }

  return {
    coverage: {
      sessionsTotal: digests.length,
      sessionsWithMetrics: withMetrics,
      ratio: digests.length > 0 ? withMetrics / digests.length : 0,
    },
    filters: { since: opts.since ?? null, limit: limit ?? null },
    totals: {
      ...totals,
      errorRate: toolResults > 0 ? errorResults / toolResults : 0,
    },
    sessions,
    byModel,
    byPhase,
    dispatches: {
      ...dispatches,
      skipRate: dispatches.total > 0 ? dispatches.skipped / dispatches.total : 0,
    },
    grades,
  };
}

/* ---------- rendering ---------- */

/** @param {number} value */
function pct(value) {
  return `${(num(value) * 100).toFixed(1)}%`;
}

/** @param {number} value */
function big(value) {
  return num(value).toLocaleString('en-US');
}

/**
 * @param {string[][]} rows first row is the header
 * @param {('left'|'right')[]} align
 */
function table(rows, align) {
  if (rows.length === 0) return '';
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i] ?? '').length)));
  return rows
    .map((row) =>
      row
        .map((cell, i) =>
          align[i] === 'right'
            ? String(cell ?? '').padStart(widths[i])
            : String(cell ?? '').padEnd(widths[i]),
        )
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

/**
 * The analysis as a terminal report.
 *
 * Coverage leads, always — every number below it describes only the sessions
 * that carry metrics, and a reader who missed that would over-read the rest.
 *
 * @param {Record<string, any>} analysis
 * @returns {string}
 */
export function formatAnalysis(analysis) {
  const a = analysis && typeof analysis === 'object' ? analysis : {};
  const coverage = a.coverage ?? { sessionsTotal: 0, sessionsWithMetrics: 0, ratio: 0 };
  const out = [];

  out.push(
    `Coverage: ${coverage.sessionsWithMetrics ?? 0} of ${coverage.sessionsTotal ?? 0} analysed sessions carry metrics (${pct(coverage.ratio)})`,
  );
  if (a.filters?.since) out.push(`  since ${a.filters.since}`);
  if (a.filters?.limit) out.push(`  most recent ${a.filters.limit}`);

  if (!coverage.sessionsTotal) {
    out.push('');
    out.push('Nothing to analyse yet — no finished sessions in .forge/sessions.jsonl.');
    out.push('Numbers appear once a session reaches `forge phase done`.');
    return `${out.join('\n')}\n`;
  }

  const totals = a.totals ?? {};
  out.push('');
  out.push(
    `Totals across measured sessions: ${big(totals.requests)} requests, ` +
      `${big(totals.totalTokens)} tokens (${big(totals.outputTokens)} out), ` +
      `${big(totals.subagents)} subagents, ${pct(totals.errorRate)} tool errors`,
  );

  const models = Object.entries(a.byModel ?? {});
  if (models.length) {
    out.push('');
    out.push('By model  (tokens cover the sessions whose metrics.json still exists)');
    out.push(
      table(
        [
          ['model', 'sessions', 'detailed', 'requests', 'output', 'total', 'err', 'grades'],
          ...models
            .sort((x, y) => y[1].requests - x[1].requests || x[0].localeCompare(y[0]))
            .map(([model, row]) => [
              model,
              String(row.sessions),
              String(row.detailed),
              big(row.requests),
              big(row.output),
              big(row.input + row.output + row.cacheRead + row.cacheCreate),
              pct(row.sessionErrorRate),
              row.grades.join('') || '—',
            ]),
        ],
        ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'left'],
      ),
    );
  }

  const phases = Object.entries(a.byPhase ?? {});
  if (phases.length) {
    out.push('');
    out.push('By phase');
    out.push(
      table(
        [
          ['phase', 'sessions', 'requests', 'output', 'total'],
          ...phases
            .sort((x, y) => y[1].requests - x[1].requests || x[0].localeCompare(y[0]))
            .map(([phase, row]) => [
              phase,
              String(row.sessions),
              big(row.requests),
              big(row.output),
              big(row.input + row.output + row.cacheRead + row.cacheCreate),
            ]),
        ],
        ['left', 'right', 'right', 'right', 'right'],
      ),
    );
  }

  const d = a.dispatches ?? {};
  out.push('');
  if (num(d.total) > 0) {
    out.push(
      `Model policy: ${big(d.total)} dispatches over ${big(d.sessions)} sessions — ` +
        `${big(d.allowed)} allowed, ${big(d.rewritten)} rewritten, ${big(d.denied)} denied. ` +
        `forge resolve-model bypassed on ${pct(d.skipRate)}.`,
    );
  } else {
    out.push(
      'Model policy: no dispatches recorded. Wire the PreToolUse hook (forge init) to measure them.',
    );
  }

  const sessions = Array.isArray(a.sessions) ? a.sessions : [];
  if (sessions.length) {
    out.push('');
    out.push('Sessions  (newest first)');
    out.push(
      table(
        [
          ['session', 'grade', 'tasks', 'requests', 'tokens', 'subagents', 'skipped'],
          ...sessions.map((s) => [
            s.slug ?? s.sessionId ?? '—',
            s.grade ?? '—',
            s.tasks ?? '—',
            s.hasMetrics ? big(s.requests) : '—',
            s.hasMetrics ? big(s.totalTokens) : '—',
            s.subagents === null || s.subagents === undefined ? '—' : big(s.subagents),
            s.dispatchesSkipped === null || s.dispatchesSkipped === undefined
              ? '—'
              : big(s.dispatchesSkipped),
          ]),
        ],
        ['left', 'left', 'right', 'right', 'right', 'right', 'right'],
      ),
    );
    out.push('');
    out.push('—  means the session predates telemetry or its numbers were never measured.');
  }

  return `${out.join('\n')}\n`;
}
