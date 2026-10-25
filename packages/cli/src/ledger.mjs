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
 *   .forge/known-false.jsonl refuted claims, with the session that learned them
 *
 * Both are append-with-replace (keyed by sessionId), tolerant of corrupt
 * lines, and never throw — a ledger must not block a phase transition.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadDeferrals } from './integrity.mjs';
import { reviewCensus } from './review-census.mjs';
import { reviewEvidence } from './metrics/review-evidence.mjs';
import { frozenReviewVerdict } from './review-verdict.mjs';
import { sessionHealth } from './health.mjs';
import { readRefutations } from './refute.mjs';
import { dispatchBudgetState } from './metrics/dispatches.mjs';
import { readVersion } from './version.mjs';

/** The version in this CLI's own package.json (resolved from the module, not the cwd); null when unreadable. */
const forgekitVersion = () => {
  const version = readVersion();
  return version === 'unknown' ? null : version;
};

/** @param {string} forgeDir */
export function projectKnownFalsePath(forgeDir) {
  return path.join(forgeDir, 'known-false.jsonl');
}

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

const LOCK_STALE_MS = 5_000;
const LOCK_TIMEOUT_MS = 10_000;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/**
 * Run `fn` holding an exclusive `<file>.lock`. Project-level ledgers are
 * shared by every forge session in the checkout, and their writers are
 * read-modify-write: two sessions without this both read the same snapshot
 * and the second write drops the first one's line (or mints the same id).
 *
 * ponytail: a lock older than LOCK_STALE_MS is taken as a crashed holder and
 * broken; two waiters breaking it at once can both enter. Holders keep it for
 * milliseconds, so that needs a >5s stall — use a real lock library if not.
 *
 * @template T
 * @param {string} file
 * @param {() => T} fn
 * @returns {T}
 */
export function withLedgerLock(file, fn) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      break;
    } catch (err) {
      // EPERM / EBUSY: Windows reports a lock that is mid-delete this way.
      if (!['EEXIST', 'EPERM', 'EBUSY'].includes(/** @type {any} */ (err)?.code)) throw err;
    }
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(lock, { force: true });
        continue;
      }
    } catch {
      continue; // released between open and stat
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${lock}`);
    Atomics.wait(sleepCell, 0, 0, 5 + Math.random() * 20);
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/**
 * Replace a jsonl ledger via temp file + rename, so an unlocked reader never
 * sees a half-written file.
 * @param {string} file
 * @param {Record<string, any>[]} entries
 */
export function writeLedger(file, entries) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * @param {string} file
 * @param {Record<string, any>[]} lines
 * @param {(entry: Record<string, any>) => boolean} [replaceWhen] existing entries matching this are dropped
 */
function appendLines(file, lines, replaceWhen) {
  if (lines.length === 0) return 0;
  try {
    return withLedgerLock(file, () => {
      const kept = replaceWhen ? readLedger(file).filter((e) => !replaceWhen(e)) : readLedger(file);
      writeLedger(file, [...kept, ...lines]);
      return lines.length;
    });
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
 * Coordinator-versus-subagent facts for the digest, copied from the metrics
 * document as measured. Kept beside `metrics` rather than inside it: the
 * compact block is a fixed shape other readers key on, and these three are
 * independent measurements that are each `null` where the host could not
 * separate the two sides — never estimated, never defaulted to zero.
 *
 * @param {unknown} doc a parsed metrics.json — or anything at all
 * @returns {{ breakdown: object | null, coordinator: object | null,
 *   groups: object[] | null } | null} null when no metrics were collected
 */
function requestSplitFacts(doc) {
  if (!doc || typeof doc !== 'object' || doc.available !== true) return null;
  const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
  return {
    // `coordinator: null` is the collector saying the host could not separate
    // the sides, so its file-level breakdown is not a coordinator/subagent split.
    breakdown: doc.coordinator === null ? null : obj(doc.breakdown),
    coordinator: obj(doc.coordinator),
    groups: Array.isArray(doc.groups) ? doc.groups : null,
  };
}

/**
 * The models the coordinator and the subagents ran on, as measured. Both `null`
 * wherever the host could not separate the sides (`coordinator: null`), the
 * metrics were not collected, or the document predates the lists — an unknown,
 * never an empty list.
 *
 * @param {unknown} doc a parsed metrics.json — or anything at all
 * @returns {{ coordinator: string[] | null, subagents: string[] | null }}
 */
function modelsFacts(doc) {
  const none = { coordinator: null, subagents: null };
  if (!doc || typeof doc !== 'object' || doc.available !== true || !doc.coordinator) return none;
  const names = (value) => (Array.isArray(value) && value.every((m) => typeof m === 'string') ? value : null);
  const coordinator = names(doc.coordinator.models);
  const subagents = names(doc.subagentModels);
  return coordinator && subagents ? { coordinator, subagents } : none;
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

const ADR_CANDIDATE_RE = /ADR-candidate:/g;
const ASSUMPTIONS_HEADING_RE = /^##\s+Assumptions\b/;
const HEADING_RE = /^##\s+/;
const ASSUMPTION_BULLET_RE = /^-\s+/;

/**
 * Brainstorm-hardening signals (design decision 3): whether
 * `brainstorm/notes.md` exists, how many `- ` bullets sit under its
 * `## Assumptions` heading, and how many `ADR-candidate:` entries were
 * recorded in `brainstorm/decisions.md`. `cleanup-sessions` deletes the whole
 * session dir at done — same "outlive the directory" argument as
 * `readMetricsDoc` above — so a session dir already gone (or a read failure
 * of any kind) degrades to null/zero rather than costing the digest line.
 *
 * @param {string} sessionDir
 * @returns {{ notes: boolean | null, assumptions: number, adrCandidates: number }}
 */
function readBrainstormSignals(sessionDir) {
  const absent = { notes: null, assumptions: 0, adrCandidates: 0 };
  try {
    if (!fs.existsSync(sessionDir)) return absent;
    const notesFile = path.join(sessionDir, 'brainstorm', 'notes.md');
    const notes = fs.existsSync(notesFile);
    let assumptions = 0;
    if (notes) {
      let inAssumptions = false;
      for (const line of fs.readFileSync(notesFile, 'utf8').split('\n')) {
        if (ASSUMPTIONS_HEADING_RE.test(line)) {
          inAssumptions = true;
          continue;
        }
        if (!inAssumptions) continue;
        if (HEADING_RE.test(line)) break;
        if (ASSUMPTION_BULLET_RE.test(line)) assumptions += 1;
      }
    }
    const decisionsFile = path.join(sessionDir, 'brainstorm', 'decisions.md');
    let adrCandidates = 0;
    if (fs.existsSync(decisionsFile)) {
      const matches = fs.readFileSync(decisionsFile, 'utf8').match(ADR_CANDIDATE_RE);
      adrCandidates = matches ? matches.length : 0;
    }
    return { notes, assumptions, adrCandidates };
  } catch {
    return absent;
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
    // Live census consults host evidence the same way `freezeReviewVerdict`
    // does (F63). Frozen overlay below still wins when present; without it, a
    // stamp alone must not outrank a measured stop.
    const evidence = reviewEvidence({ session, env: process.env });
    const census = reviewCensus(sessionDir, { evidence });
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
    const budget = dispatchBudgetState({ sessionDir, cwd: path.dirname(forgeDirOf(opts, sessionDir)) });
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
      requestSplit: requestSplitFacts(metricsDoc),
      // Which release wrote this line (`forge escapes report --by version`), and
      // the models each side ran on — read, like the rest, before the session dir is cleaned.
      forgekitVersion: forgekitVersion(),
      models: modelsFacts(metricsDoc),
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
      // The plan-time exit ramp's resolved shape (D2), for a session that
      // left through it. `set-phase` records this on the session at the
      // `skipped` transition and it is kept only there until now — read
      // back here, never recomputed, since the change directory the shape
      // was read from may no longer exist by the time anything reads this
      // ledger line.
      exitReason: session.exitReason ?? null,
      // set-phase tells the operator this is "kept on the session and in
      // .forge/sessions.jsonl". It was kept only on the session, so the reason a
      // reviewer was declined evaporated at cleanup — while the cap it explains
      // survived in the score.
      finalReviewWaived: session.finalReviewWaived ?? null,
      // set-phase's archive gate tells the operator --archive-waived is "kept
      // on the session and in .forge/sessions.jsonl" — same session-only-dies-
      // at-cleanup argument as finalReviewWaived above, so it is read back
      // here rather than recomputed.
      archiveWaived: session.archiveWaived ?? null,
      // set-phase's brainstorm-notes gate tells the operator --notes-waived is
      // "kept on the session and in .forge/sessions.jsonl" — same
      // session-only-dies-at-cleanup argument as archiveWaived above.
      notesWaived: session.notesWaived ?? null,
      // I5 (final review): `paceSuppressed` and `exitDeclined` were written
      // by `set-phase.mjs` (`recordPaceSuppression`, `recordExitDeclined`)
      // and read by nothing in production — session-only, so both died with
      // the session directory at 14-day cleanup. Same argument as
      // `exitReason` above: a suppressed adjustment (D4) or a declined exit
      // offer must stay countable past the session that recorded it, never
      // recomputed here.
      paceSuppressed: session.paceSuppressed ?? null,
      exitDeclined: session.exitDeclined ?? null,
      // What the plan projected at the implement transition (kept on the
      // session, not recomputed from a plan that may have changed since), what
      // the dispatch log counted, and the budget in force. `actual` is null
      // for an unreadable log — an unknown, never a zero.
      dispatchBudget: { projected: session.dispatchProjected ?? null, actual: budget.n, budget: budget.budget },
      durationHours,
      startedAt: session.createdAt ?? null,
      endedAt: session.updatedAt ?? null,
      // Spec-churn proxy (design decision 2/3): `forge brief stamp` increments
      // these on the session; read back here rather than recomputed, same
      // session-only-dies-at-cleanup argument as archiveWaived above.
      briefStamps: session.briefStamps ?? null,
      briefRestampsAfterImplement: session.briefRestampsAfterImplement ?? null,
      brainstorm: readBrainstormSignals(sessionDir),
      // The change's commits, recorded at done — what `forge escapes` reads.
      commitRange: session.commitRange ?? null,
      // Per nested repository; null = recorded before this existed (`forge escapes` infers).
      nestedCommitRanges: session.nestedCommitRanges ?? null,
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
 * Refuted claims, promoted out of the session before it is deleted. A
 * refutation is negative memory for the *project* — the wrong prior a
 * reviewer or gate contradicted in this change is the same wrong prior the
 * next change's brainstorm would start from. `forge refute list --all` reads
 * this back.
 *
 * @param {{ cwd?: string, sessionDir: string, session: Record<string, any> }} opts
 */
export function appendKnownFalseLedger(opts) {
  const { sessionDir, session } = opts;
  try {
    const lines = readRefutations(sessionDir).map((r) => ({
      sessionId: session.id ?? null,
      slug: session.slug ?? null,
      change: session.openspecChange ?? null,
      id: r.id ?? null,
      task: r.task ?? null,
      claim: r.claim ?? null,
      actual: r.actual ?? null,
      source: r.source ?? null,
      at: r.at ?? null,
      carriedAt: new Date().toISOString(),
    }));
    return appendLines(
      projectKnownFalsePath(forgeDirOf(opts, sessionDir)),
      lines,
      (e) => e.sessionId === (session.id ?? null),
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
