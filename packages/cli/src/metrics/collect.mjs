/**
 * Compose the host readers into one metrics document for a Forge session.
 *
 * `metrics/host.mjs` answers *which* transcripts belong to this session and
 * `metrics/transcript.mjs` answers *what they cost*. This module is the join,
 * and it owns the two rules that neither of them can decide alone.
 *
 * THE SUMMING RULE — the top-level `requests`, `tokens`, `byModel`, `byPhase`,
 * `tools` and `errors` cover the **whole** session: the coordinator plus every
 * subagent it dispatched. "What did this session cost" has no other honest
 * answer, and subagent work is where most of the tokens go. Adding the two is
 * safe because parent transcripts carry zero `isSidechain` requests — sidechain
 * work lives only in the `subagents/` sidecars — so the sides are disjoint and
 * nothing is counted twice. `breakdown` keeps the split, so a consumer can
 * still separate coordinator cost from delegated cost without re-reading a
 * single file.
 *
 * THE WINDOW RULE — binding says which *files*; the window says which *lines*.
 * A host session routinely outlives the Forge session that started it: run
 * `forge new` twice in one Claude Code session and both sessions bind to the
 * same transcript and the same sidecar directory. So every line is kept only
 * if its `timestamp` falls inside `[session.createdAt, collectedAt]`, and a
 * line with no parsable timestamp is dropped rather than guessed at. The
 * filter runs on **raw lines, before** `usageByRequest` — a request restated
 * across several lines is then judged by the lines it actually has in the
 * window, and the dedupe still settles its output count the way it always
 * does. Filtering deduplicated requests instead would hand the whole request
 * to whichever side its first line fell on.
 *
 * Nothing here re-derives a token count. `usageByRequest` owns the collapse of
 * per-content-block lines into requests, including the last-line-wins rule
 * that a first-line-wins bug once cost 28.6% of all output tokens; anything
 * that counts usage outside that function reintroduces the risk.
 *
 * `collectMetrics` reads, counts and returns; the only thing it wants from the
 * session directory is `dispatches.jsonl`, the one input that is Forge's own
 * rather than the host's. Every failure degrades to `{available: false,
 * reason}`: this runs inside `forge phase done` and must never block a
 * transition.
 *
 * `writeMetrics` is the one persisting function, and it lives here because the
 * rule it enforces is about degradation: **a measurement already taken is never
 * replaced by an admission that it can no longer be taken.** Host transcripts
 * get pruned, so re-collecting a finished session would otherwise trade real
 * per-model and per-phase numbers for `available: false` — and `metrics.json`
 * is the only place that detail exists, since the digest keeps totals alone.
 */

import fs from 'node:fs';
import path from 'node:path';

import { foldDispatches, readDispatches } from './dispatches.mjs';
import { detectHost, findTranscripts } from './host.mjs';
import {
  aggregateTokens,
  aggregateTools,
  readJsonl,
  readSubagents,
  usageByRequest,
} from './transcript.mjs';

/**
 * An ISO timestamp for "now" that cannot throw, whatever the caller injected.
 *
 * @param {(() => Date) | undefined} now
 * @returns {string}
 */
function nowIso(now) {
  try {
    const value = typeof now === 'function' ? now() : new Date();
    return new Date(value).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/**
 * An ISO timestamp as epoch milliseconds, or null for anything unparsable.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function msOf(value) {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * A document that explains itself instead of counting.
 *
 * `hostVersion` rides along whenever it is knowable — if the host changes its
 * transcript format, every session degrades at once and the version is the
 * only thing in the file that says why.
 *
 * `dispatches` rides along for the same reason: it is folded from Forge's own
 * `dispatches.jsonl`, not from a host transcript, so a session with no binding
 * or a pruned transcript still knows exactly what it dispatched. Reporting that
 * only when the transcripts happen to be readable would discard the one
 * measurement that is still intact.
 *
 * @param {string} collectedAt
 * @param {string} reason
 * @param {ReturnType<typeof foldDispatches>} dispatches
 * @param {string | null} [hostVersion]
 * @returns {Record<string, any>}
 */
function degraded(collectedAt, reason, dispatches, hostVersion = null) {
  return { available: false, collectedAt, reason, hostVersion, dispatches };
}

/**
 * Attribute deduplicated request entries to the phase that was active when
 * each of them started.
 *
 * `phaseHistory` is the join key: a chronological `{phase, at}` trail written
 * by `forge new` and `forge phase`. A request belongs to the latest entry
 * whose `at` is at or before its timestamp, so a request landing exactly on a
 * transition belongs to the phase that just began.
 *
 * Rows with an unparsable `at` are dropped from the timeline rather than
 * poisoning the order, and a phase re-entered later in the session
 * (`implement → verify → implement`) accumulates into its single bucket — the
 * table is keyed by phase name, never by position in the history.
 *
 * @param {ReturnType<typeof usageByRequest>} entries
 * @param {unknown} phaseHistory
 * @returns {Record<string, { requests: number, input: number, output: number,
 *   cacheRead: number, cacheCreate: number }>} prototype-less, for the same
 *   reason as `byModel`; `{}` when there is no usable timeline.
 */
function attributeByPhase(entries, phaseHistory) {
  /** @type {Record<string, any>} */
  const table = Object.create(null);
  const timeline = (Array.isArray(phaseHistory) ? phaseHistory : [])
    .map((row) => ({ phase: row?.phase, at: msOf(row?.at) }))
    .filter((row) => typeof row.phase === 'string' && row.phase && row.at !== null)
    .sort((a, b) => a.at - b.at);
  if (timeline.length === 0) return table;

  for (const entry of entries) {
    const ms = msOf(entry?.timestamp);
    if (ms === null) continue;
    // A request older than the first entry falls into the first phase rather
    // than being dropped: it was spent on this session, and an unattributed
    // request is a token that vanishes between `requests` and `byPhase`.
    let match = timeline[0];
    for (const row of timeline) {
      if (row.at > ms) break;
      match = row;
    }

    const bucket = (table[match.phase] ??= {
      requests: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreate: 0,
    });
    bucket.requests += 1;
    for (const field of ['input', 'output', 'cacheRead', 'cacheCreate']) {
      bucket[field] += entry.usage?.[field] ?? 0;
    }
  }
  return table;
}

/**
 * The host version written in the bound transcripts, ignoring the window.
 *
 * Only for the degraded paths: when nothing falls inside the window there are
 * no counts to report, and the version is then the one thing in the document
 * that makes a host format change diagnosable. It re-reads rather than holding
 * every out-of-window line in memory for a case that almost never fires — the
 * largest transcript here is 57.5 MB, and the happy path should not carry that
 * on the chance that it ends up empty.
 *
 * @param {{ transcript: string }[]} bound
 * @returns {string | null} the first version any bound transcript admits to
 */
function observedHostVersion(bound) {
  for (const { transcript } of bound) {
    const version = aggregateTokens(usageByRequest(readJsonl(transcript))).hostVersion;
    if (version !== null) return version;
  }
  return null;
}

/**
 * Every subagent transcript file in a sidecar directory.
 *
 * Discovery only — the transcript/meta *pairing* and the record building stay
 * in `readSubagents`, which is also where the `agent-<id>.jsonl` naming is
 * asserted. This exists because the session-wide `tools`, `byModel` and
 * `byPhase` tables need the sidecars' raw lines, and a record is already a
 * roll-up: it can no longer say which tool ran or when a request happened.
 *
 * @param {string | null | undefined} sidecarDir
 * @returns {string[]}
 */
function sidecarTranscripts(sidecarDir) {
  if (typeof sidecarDir !== 'string' || !sidecarDir) return [];
  try {
    return fs
      .readdirSync(sidecarDir)
      .filter((name) => /^agent-.+\.jsonl$/.test(name))
      .map((name) => path.join(sidecarDir, name));
  } catch {
    return []; // missing, unreadable, or not a directory — advisory
  }
}

/**
 * Harvest token, model, tool and phase metrics for one Forge session.
 *
 * Counts only what happened inside `[session.createdAt, collectedAt]` on the
 * transcripts the session is bound to. **A line whose `timestamp` is missing
 * or unparsable is excluded** — it cannot be attributed to a window honestly,
 * and a session that shares a host session with another would otherwise
 * inherit its undated work.
 *
 * Persists nothing and returns only counts, model slugs, tool names, agent
 * types, phase names and timestamps. Never throws: telemetry is advisory, so
 * every failure — no binding, no file, no readable line, nothing in the
 * window, or an unforeseen error — comes back as `{available: false, reason}`
 * with the host version attached whenever it is knowable.
 *
 * @param {{ session?: Record<string, any>, sessionDir?: string,
 *   env?: Record<string, string | undefined>, now?: () => Date,
 *   configDir?: string }} [options] `now` is injectable so a test can pin the
 *   window's upper edge; `configDir` and `env` are passed through to
 *   `findTranscripts`; `sessionDir` is where `dispatches.jsonl` lives — omit it
 *   and the dispatch counts are simply zero. Unknown keys are ignored.
 * @returns {Record<string, any>} the metrics document, `available: true` or
 *   `false` with a reason — never a throw.
 */
export function collectMetrics(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const collectedAt = nowIso(opts.now);
  // Folded first, and outside the try, so it is available to every return
  // below — including the degraded ones, which is the whole point of it not
  // depending on a transcript.
  const dispatches = foldDispatches(readDispatches(opts.sessionDir));
  try {
    const session = opts.session && typeof opts.session === 'object' ? opts.session : {};
    const host = session.host && typeof session.host === 'object' ? session.host : {};
    const sessionIds = (Array.isArray(host.sessionIds) ? host.sessionIds : []).filter(
      (id) => typeof id === 'string' && id,
    );
    if (sessionIds.length === 0) {
      return degraded(
        collectedAt,
        'no host session bound to this Forge session — nothing to harvest',
        dispatches,
      );
    }

    const bound = findTranscripts(sessionIds, { configDir: opts.configDir, env: opts.env });
    if (bound.length === 0) {
      return degraded(
        collectedAt,
        `no transcript on disk for host session ${sessionIds.join(', ')} — pruned or written elsewhere`,
        dispatches,
      );
    }

    const fromMs = msOf(session.createdAt);
    if (fromMs === null) {
      // No window start means no window, and a host session routinely spans
      // several Forge sessions: attributing the whole transcript to a session
      // that cannot say when it began would bill it for its predecessors.
      return degraded(
        collectedAt,
        'session has no parsable createdAt — no window to attribute',
        dispatches,
      );
    }
    const toMs = msOf(collectedAt);
    /**
     * Binding says which files; the window says which lines.
     *
     * @param {Record<string, any>} line
     * @returns {boolean}
     */
    const inWindow = (line) => {
      const ms = msOf(line?.timestamp);
      return ms !== null && ms >= fromMs && ms <= toMs;
    };

    // Only the lines that survive the window are retained: a host session can
    // hold several Forge sessions' worth of transcript, and the discarded
    // majority has no reason to stay resident.
    let rawLineCount = 0;
    /** @type {Record<string, any>[]} */
    const parentLines = [];
    for (const { transcript } of bound) {
      for (const line of readJsonl(transcript)) {
        rawLineCount += 1;
        if (inWindow(line)) parentLines.push(line);
      }
    }

    /** @type {Record<string, any>[]} */
    const sidecarLines = [];
    /** @type {ReturnType<typeof readSubagents>} */
    const subagents = [];
    for (const { sidecarDir } of bound) {
      for (const file of sidecarTranscripts(sidecarDir)) {
        for (const line of readJsonl(file)) {
          rawLineCount += 1;
          if (inWindow(line)) sidecarLines.push(line);
        }
      }
      // A record with nothing left inside the window is a subagent of some
      // *other* Forge session that shared this host session. It cannot be
      // placed in time — the same reason an undated line is dropped — so it is
      // not this session's to report. This also drops a dispatch whose
      // transcript is missing entirely: `readSubagents` keeps that record
      // deliberately, but a windowed document has no evidence it ran here.
      for (const record of readSubagents(sidecarDir, { filter: inWindow })) {
        if (record.requests > 0) subagents.push(record);
      }
    }

    if (rawLineCount === 0) {
      return degraded(
        collectedAt,
        `the bound transcript${bound.length === 1 ? '' : 's'} held no readable lines`,
        dispatches,
      );
    }
    if (parentLines.length + sidecarLines.length === 0) {
      // The files are fine, they just describe someone else's work. Told apart
      // from an unreadable transcript on purpose: one is a broken host, the
      // other is an ordinary second Forge session in the same host session.
      return degraded(
        collectedAt,
        `no transcript line falls inside the session window ${session.createdAt} … ${collectedAt}`,
        dispatches,
        observedHostVersion(bound),
      );
    }

    // Parent transcripts carry zero `isSidechain` requests — subagent work
    // lives only in the sidecars — so the two sides are disjoint and adding
    // them double-counts nothing. Each side is rolled up separately for the
    // breakdown and the union is rolled up again for the totals, rather than
    // merging two summaries by hand: one more pass over deduplicated entries
    // is cheap, and a bespoke merge is one more place for a token to go
    // missing.
    const parentEntries = usageByRequest(parentLines);
    const sidecarEntries = usageByRequest(sidecarLines);
    const allEntries = parentEntries.concat(sidecarEntries);
    const parentSummary = aggregateTokens(parentEntries);
    const sidecarSummary = aggregateTokens(sidecarEntries);
    const total = aggregateTokens(allEntries);
    const tools = aggregateTools(parentLines.concat(sidecarLines));

    return {
      available: true,
      collectedAt,
      source: {
        agent:
          typeof host.agent === 'string' && host.agent ? host.agent : detectHost(opts.env).agent,
        hostVersion: total.hostVersion,
        transcripts: bound.map((entry) => entry.transcript),
        // How many subagents this session actually ran, not how many files sit
        // in the sidecar directory — that directory belongs to the host session
        // and holds every Forge session's dispatches.
        sidecars: subagents.length,
      },
      window: { from: session.createdAt, to: collectedAt },
      requests: total.requests,
      tokens: total.tokens,
      byModel: total.byModel,
      byPhase: attributeByPhase(allEntries, session.phaseHistory),
      tools: tools.tools,
      errors: tools.errors,
      dispatches,
      subagents,
      breakdown: {
        parent: { requests: parentSummary.requests, tokens: parentSummary.tokens },
        subagents: { requests: sidecarSummary.requests, tokens: sidecarSummary.tokens },
      },
    };
  } catch (error) {
    return degraded(
      collectedAt,
      `metrics collection failed: ${error?.message ?? error}`,
      dispatches,
    );
  }
}

/**
 * Persist a metrics document, refusing to trade good news for bad.
 *
 * A degraded document does not overwrite an `available: true` one. That is the
 * only case it declines: better news, equally bad news, a corrupt file and a
 * first collection all write normally, and `force` writes unconditionally for
 * the operator who genuinely wants the current (degraded) truth on disk.
 *
 * Never throws — the caller warns and carries on.
 *
 * @param {{ sessionDir: string, doc: Record<string, any>, force?: boolean }} opts
 * @returns {{ written: boolean, kept: boolean, file: string, error?: string }}
 *   `kept` distinguishes "deliberately preserved the old document" from
 *   "could not write", which read the same to a caller checking only `written`.
 */
export function writeMetrics(opts) {
  const file = path.join(opts.sessionDir, 'metrics.json');
  try {
    if (opts.force !== true && opts.doc?.available !== true) {
      let existing = null;
      try {
        existing = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        existing = null; // absent or corrupt — nothing worth preserving
      }
      if (existing && existing.available === true) return { written: false, kept: true, file };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(opts.doc, null, 2)}\n`, 'utf8');
    return { written: true, kept: false, file };
  } catch (error) {
    return { written: false, kept: false, file, error: String(error?.message ?? error) };
  }
}
