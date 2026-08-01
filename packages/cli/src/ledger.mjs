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
import { frozenReviewVerdict } from './review-verdict.mjs';
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

const COMPACT_TOKEN_FIELDS = ['input', 'output', 'cacheRead', 'cacheCreate'];

/**
 * Compact request + token cells for a byModel / byPhase map.
 *
 * @param {unknown} table
 * @param {{ dropSynthetic?: boolean }} [opts]
 */
function compactSplitTable(table, opts = {}) {
  const out = Object.create(null);
  if (!table || typeof table !== 'object') return out;
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  for (const [key, cell] of Object.entries(table)) {
    if (typeof key !== 'string' || !key) continue;
    if (opts.dropSynthetic && key === '<synthetic>') continue;
    const src = cell && typeof cell === 'object' ? cell : {};
    const row = { requests: num(src.requests) };
    for (const field of COMPACT_TOKEN_FIELDS) row[field] = num(src[field]);
    out[key] = row;
  }
  return out;
}

/**
 * The totals worth keeping forever, distilled from a metrics document.
 *
 * `metrics.json` dies with the session directory; this is the part that
 * survives in `sessions.jsonl`, so it is deliberately compact — session
 * totals plus per-model / per-phase request and token splits. Per-tool and
 * per-subagent records stay in `metrics.json`. `totalTokens` counts all four
 * token classes because cache reads dominate a long session, and a digest
 * reporting only input+output would understate it by an order of magnitude.
 *
 * Takes the document rather than a path so the writer of `metrics.json` and
 * this reader cannot disagree about what "the totals" means.
 *
 * @param {unknown} doc a parsed metrics.json — or anything at all
 * @returns {{ available: false } | { available: true, requests: number,
 *   outputTokens: number, totalTokens: number, models: string[],
 *   byModel: Record<string, object>, byPhase: Record<string, object>,
 *   errorRate: number, subagents: number }}
 */
export function compactMetrics(doc) {
  if (!doc || typeof doc !== 'object' || doc.available !== true) return { available: false };
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const tokens = doc.tokens && typeof doc.tokens === 'object' ? doc.tokens : {};
  const byModel = compactSplitTable(doc.byModel, { dropSynthetic: true });
  const byPhase = compactSplitTable(doc.byPhase);
  return {
    available: true,
    requests: num(doc.requests),
    outputTokens: num(tokens.output),
    totalTokens:
      num(tokens.input) + num(tokens.output) + num(tokens.cacheRead) + num(tokens.cacheCreate),
    // Sorted, so diffing two ledger lines is about the numbers rather than
    // about the order the models happened to appear in. `<synthetic>` is
    // filtered for consistency with collection (F69).
    models: Object.keys(byModel).sort(),
    byModel,
    byPhase,
    errorRate: num(doc.errors?.rate),
    subagents: Array.isArray(doc.subagents) ? doc.subagents.length : 0,
  };
}

/**
 * What the dispatch ledger contributes to the digest, from a document that may
 * be able to say nothing else.
 *
 * `metrics.dispatches` is folded from Forge's own `dispatches.jsonl` rather
 * than from a host transcript, so it survives on an unbound session and on one
 * whose transcript the host has pruned — which is exactly when the rest of the
 * document is `available: false` and these two numbers are all that is left.
 *
 * `dispatched` counts the dispatches that became subagents: everything the
 * policy hook saw except the ones it refused. A denied dispatch never ran.
 *
 * Absent counts stay `null`, never `0` — a session predating this field and a
 * session that genuinely corrected nothing must not read the same.
 *
 * `table` is the whole five-number breakdown, kept because a skip *count* with
 * no denominator cannot become a skip *rate* — and after `forge cleanup` the
 * digest is the only place either number exists. Five small integers is a
 * cheap price for the question the feature was commissioned to answer.
 *
 * @param {unknown} doc
 * @returns {{ skipped: number | null, dispatched: number | null,
 *   table: Record<string, number> | null }}
 */
function dispatchFacts(doc) {
  const source = doc && typeof doc === 'object' ? doc.dispatches : null;
  if (!source || typeof source !== 'object') {
    return { skipped: null, dispatched: null, table: null };
  }
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const allowed = num(source.allowed);
  const rewritten = num(source.rewritten);
  /** @type {Record<string, number>} */
  const table = {};
  for (const key of ['total', 'allowed', 'rewritten', 'denied', 'skipped']) {
    table[key] = num(source[key]) ?? 0;
  }
  // Both read off the same table so they cannot disagree: `null` means no
  // dispatch block was ever written, and once one exists a missing key inside
  // it is a zero, not a second flavour of "unmeasured".
  return {
    skipped: table.skipped,
    dispatched: allowed === null || rewritten === null ? null : allowed + rewritten,
    table,
  };
}

/**
 * `metrics.json` as an object, or null. Missing is the ordinary case (no host,
 * no transcript, a session that never reached done); corrupt must not cost the
 * digest line, which is the only thing that outlives the session directory.
 *
 * @param {string} sessionDir
 * @returns {Record<string, any> | null}
 */
function readMetricsDoc(sessionDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionDir, 'metrics.json'), 'utf8'));
  } catch {
    return null;
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
    // THE VERDICT IS NOT RE-MEASURED HERE. `set-phase.mjs` measured it at the
    // `finish`/`done` transition from the host's own dispatch record and froze
    // it onto the session; this line only reads it back. Recomputing would be
    // wrong twice over. The evidence expires — a one-day-old session on this
    // machine already has no surviving host transcript, so the answer would
    // silently drift to the prose reading, and a digest line is a record of
    // what was measured at the transition rather than a claim about what is
    // true now.
    //
    // `null` means no verdict was frozen — every session that finished before
    // this change — and only then does the live census decide.
    //
    // The other three counts stay on the live census deliberately: per-group
    // `independent`/`selfChecks` are read from prose by design (see the scope
    // note in `review-census.mjs`), and only `finalReview` is graded.
    const frozen = frozenReviewVerdict(session);
    const metricsDoc = readMetricsDoc(sessionDir);
    const metrics = compactMetrics(metricsDoc);
    const dispatch = dispatchFacts(metricsDoc);
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
      // Measured beats declared: `--subagents N` is bookkeeping a coordinator
      // maintains by hand, and this project's own ledger holds null, null, 0
      // for three sessions that certainly dispatched. Sidecars first — they are
      // direct evidence a subagent ran; then the dispatch ledger, which only
      // saw it dispatched; then the declared figure, which is all there is when
      // neither was measured. A missing one stays null — a 0 would read as "no
      // subagents ran", a measurement nobody made.
      subagentsDispatched:
        metrics.subagents ?? dispatch.dispatched ?? session.subagentsDispatched ?? null,
      dispatchesSkipped: dispatch.skipped,
      dispatches: dispatch.table,
      metrics,
      reviews: {
        total: census.total,
        independent: census.independent,
        selfChecks: census.selfChecks,
        rejections: census.rejections,
        final: frozen ? frozen.final : census.finalReview,
        // How `final` was reached. Without it, fleet-report adds a verdict
        // measured from the host's dispatch record to one inferred from prose
        // and prints the sum as one number — and `rule` cannot separate them,
        // because rule 4 is *defined* as "host evidence where available, prose
        // otherwise", so a rule-4 line carries either kind. A line written
        // before this field existed has no `evidence` at all, which is
        // unknown — not a grade.
        evidence: frozen ? frozen.evidence : census.finalReviewEvidence,
        // The host's own record of an operator declining a reviewer. The spec
        // requires a stopped dispatch to be *reported*, and until this line the
        // only place it existed was the session directory, which cleanup
        // deletes — so the fact vanished while the cap it explains lived on in
        // the score, exactly like `finalReviewWaived` before it.
        //
        // Read it beside `evidence`: it is a measurement only under `host`, and
        // a placeholder `false` on every other grade, in the same sense
        // `reviewCensus` zeroes it when nothing could be measured. It applies
        // no waiver — declining a reviewer is the operator's decision to
        // record, and `finalReviewWaived` below is theirs to set.
        stoppedByOperator: frozen ? frozen.stoppedByOperator : census.stoppedByOperator,
        // Which classifier judged them. Without it, fleet-report sums verdicts
        // from incompatible rules and prints the result as one number.
        rule: census.rule ?? 0,
      },
      checkpoints: Array.isArray(session.checkpoints) ? session.checkpoints.length : 0,
      health: health.state,
      healthReasons: health.reasons,
      score: opts.card?.score ?? session.score ?? null,
      grade: opts.card?.grade ?? session.scoreGrade ?? null,
      incompleteReason: session.incompleteReason ?? null,
      // set-phase tells the operator this is "kept on the session and in
      // .forge/sessions.jsonl". It was kept only on the session, so the reason a
      // reviewer was declined evaporated at cleanup — while the cap it explains
      // survived in the score.
      finalReviewWaived: session.finalReviewWaived ?? null,
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
