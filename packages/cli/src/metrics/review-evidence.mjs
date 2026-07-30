/**
 * Read what the *host* recorded about reviewer subagents it actually ran.
 *
 * THE DISTINCTION THIS MODULE EXISTS FOR — evidence versus testimony.
 *
 * `review-census.mjs` decides whether a review was written by an independent
 * reviewer or by the coordinator grading its own work, and today it decides by
 * reading the review file's **prose**: text written by the party being judged.
 * That is testimony. It was rewritten five times in one day and was wrong every
 * time — twice at the `forge phase done` gate that guards money and auth
 * changes, once refusing correct work and once passing a session whose own text
 * said its reviewer had been declined.
 *
 * What this module reads instead is the host's `subagents/` sidecar directory:
 * an `agent-<id>.meta.json` written when a subagent is spawned and an
 * `agent-<id>.jsonl` written as it runs. A coordinator cannot write that record
 * without genuinely dispatching a subagent.
 *
 * THAT IS LESS THAN IT SOUNDS, and this comment claimed more until 0.3.34.
 * Dispatching a subagent is cheap: a throwaway one carrying the review label
 * made one request, reviewed nothing, and its record passed the money/auth gate
 * against a review file that said in plain English that nobody had read the
 * change. The record proves a *dispatch*, and nothing about a *review*. What
 * closes the gap is `maxRequests` below, and the floor `review-census.mjs`
 * applies to it — a dispatch that did no work no longer certifies anything. A
 * dispatch that does enough work to clear the floor is still not proof that the
 * work was a review; that needs the review file stamped at dispatch time, which
 * is filed as F12 and not built.
 *
 * It is nonetheless evidence the reviewed party cannot produce by *writing*,
 * which the review file is not. **Do not "simplify" this back into reading the
 * review file** — the file is the thing under suspicion.
 *
 * THE OTHER TRAP — `available: false` is not `available: true, units: {}`.
 *
 * "I could not tell" and "I checked and no reviewer ran" are different answers
 * and must stay distinguishable at every layer. Every defect this subsystem has
 * shipped was an absence of signal collapsed into a negative signal, and the
 * spec's "Absence of evidence never refuses work" requirement is the rule that
 * collapse breaks. `reviewEvidence` therefore reports `available: false` with a
 * human-readable `reason` for every case where it could not look, and reserves
 * an empty `units` for the case where it looked and found nothing.
 *
 * The first draft of this module broke that promise in its own plumbing, and
 * the shape of the mistake is worth keeping: every tolerant read returned the
 * *same* empty value for "nothing here" and for "I failed to read this". An
 * unreadable `subagents/` directory, a meta with its permission bit cleared, a
 * half-written meta and a pruned `.jsonl` all arrived as an absent record, so a
 * reviewer that genuinely ran and burnt tokens was reported as one that never
 * ran — and the gate refuses on that. Tolerance is not the same as silence: a
 * read that fails must say so. That is why `readMeta` here returns `ok` where
 * `transcript.mjs`'s returns `{}`, and why `scanSidecar` reports `readable` and
 * `problems` beside its records.
 *
 * COUNTS, NEVER CONTENT. The dispatch `description` is the input this module
 * matches on and it is never an output. Prescribing its *format* does not
 * license storing its *text*: it is free-form operator prose, these records are
 * persisted into a digest that outlives the session, and `transcript.mjs`
 * already refuses to carry it for the same reason. `unit` — the token captured
 * out of it — is a prescribed identifier, not prose, and is the only thing that
 * crosses this boundary.
 *
 * MEASUREMENT, NEVER POLICY. Each unit bucket carries four counts — how many
 * dispatches the unit had, how many of those the operator stopped, the requests
 * summed across all of them, and `maxRequests`, the largest request count of any
 * single *unstopped* dispatch. No threshold lives here. `review-census.mjs`
 * decides what count is enough; this module only says what the count was, so a
 * floor can be re-measured and moved without touching the collector.
 *
 * Everything degrades instead of throwing: this ends up inside
 * `forge phase done`, and telemetry must never block a transition.
 */

import fs from 'node:fs';
import path from 'node:path';

import { findTranscripts } from './host.mjs';
import { aggregateTokens, readJsonl, usageByRequest } from './transcript.mjs';

/**
 * The prescribed dispatch description: **exactly** `forge-review <unit>
 * <forge-session-id>` once trimmed. Not a prefix, not a substring.
 *
 * THE SESSION ID IS WHAT MAKES THE RECORD ATTRIBUTABLE. Without it the join was
 * "a review dispatch that happened somewhere in this host conversation while
 * this Forge session was open", and one Claude Code conversation routinely
 * hosts several Forge sessions — `forge new` does not start a new chat. Three
 * independent review rounds each found a fresh way for a neighbour's reviewer
 * to be credited to a session whose own review file said, in Forge's own
 * prescribed words, that the coordinator wrote it: a time window that a later
 * session's dispatch still lands inside, a `forge cleanup` that erases the
 * neighbour's `session.json`, and a ledger line that predates the field
 * recording which conversation a session ran in. Every one of them was a
 * money/auth gate passing on someone else's evidence.
 *
 * Naming the session in the description ends that class rather than patching
 * it. A record either says which Forge session dispatched it or it is not
 * counted, so there is nothing left to attribute by inference — no window, no
 * sibling search, no durable index of who shared what.
 *
 * THE MATCH IS EXACT BECAUSE A LOOSE ONE OVER-CREDITS. The rule was originally
 * "the token appears anywhere in the description", on the theory that a
 * mislabelled dispatch would under-credit rather than over-credit. Measured on
 * this change's own session, that is false in both directions: an *implementer*
 * dispatch described `forge-review implement group 1` produced a review-evidence
 * record for unit `implement`, and the prose `talk about forge-review
 * implementation details` produced one for `implementation`. A coordinator
 * describing its own work in passing could therefore manufacture the evidence
 * that unlocks the money/auth gate — the precise thing this module exists to
 * make unforgeable. An exact match fails closed instead: a mislabelled dispatch
 * matches nothing, evidence is absent, and the census falls back to prose.
 *
 * The unit's charset is restricted to identifier characters and its length is
 * capped in the pattern itself, because the unit is the one string persisted
 * into a digest that outlives the session. The session id is matched to the
 * same shape and compared, never stored. A description that does not fit is not
 * a prescribed dispatch at all.
 *
 * The trailing id is optional in the *pattern* so that a dispatch written to
 * the older two-word form is still recognised as a review dispatch — but it is
 * then unattributable, and `reviewEvidence` refuses to count it for anyone. It
 * is deliberately not treated as "no reviewer ran".
 */
const REVIEW_DESCRIPTION =
  /^forge-review\s+([a-z0-9][a-z0-9._-]{0,63})(?:\s+([a-z0-9][a-z0-9._-]{0,127}))?$/i;

/**
 * What a dispatch description names, or null for any description that is not a
 * prescribed review dispatch.
 *
 * `unit` is lower-cased on the way out: the match is case-insensitive, so a
 * dispatch written `Forge-Review FINAL` must not land in a different bucket
 * from `forge-review final` — a caller looking up `units.final` would then read
 * "no reviewer ran" off a reviewer that did. `forgeSessionId` is **not**
 * lower-cased, because session ids are compared to `session.id` verbatim and
 * carry an upper-case `T`/`Z` in their timestamp.
 *
 * @param {unknown} description
 * @returns {{ unit: string, forgeSessionId: string | null } | null}
 */
function unitOf(description) {
  if (typeof description !== 'string' || !description) return null;
  const match = REVIEW_DESCRIPTION.exec(description.trim());
  if (!match) return null;
  return { unit: match[1].toLowerCase(), forgeSessionId: match[2] ?? null };
}

function msOf(value) {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * When a dispatch started: the earliest parsable `timestamp` on any of its
 * lines, or null when it wrote none.
 *
 * Every line is considered, not only the assistant ones the token counting
 * reads — a sidecar routinely opens with the `user` line carrying the task —
 * and the file is scanned rather than trusted to be in order, because a
 * transcript is appended by a live process and its order is not a contract.
 *
 * @param {Record<string, any>[]} lines
 * @returns {string | null}
 */
function earliest(lines) {
  /** @type {string | null} */
  let best = null;
  let bestMs = Infinity;
  for (const line of lines) {
    const ms = msOf(line?.timestamp);
    if (ms === null || ms >= bestMs) continue;
    best = line.timestamp;
    bestMs = ms;
  }
  return best;
}

/**
 * Parse an `agent-<id>.meta.json`, saying whether it could be read at all.
 *
 * `transcript.mjs`'s private `readMeta` returns `{}` for missing, unreadable
 * and half-written alike, which is right for a module that only wants optional
 * metadata alongside a transcript. It is wrong here. This module's whole job is
 * to answer "was a reviewer dispatched", and a meta that exists but cannot be
 * read is a subagent whose nature is unknowable — collapsing that into the same
 * empty object as "no meta here" is what made an unreadable sidecar report "no
 * reviewer ran", refusing a change whose reviewer genuinely ran.
 *
 * So `ok` is false for every failure, and the caller decides what an
 * unknowable dispatch means. Never throws.
 *
 * @param {string | null} filePath
 * @returns {{ ok: boolean, meta: Record<string, any> }}
 */
function readMeta(filePath) {
  if (!filePath) return { ok: false, meta: {} };
  /** @type {string} */
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { ok: false, meta: {} }; // unreadable, or a directory
  }
  try {
    const parsed = JSON.parse(raw);
    // `null` parses cleanly, so the catch never sees it, and reading a field
    // off it throws. Arrays and scalars are equally not metadata.
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { ok: true, meta: parsed }
      : { ok: false, meta: {} };
  } catch {
    return { ok: false, meta: {} }; // half written
  }
}

/**
 * Read a host sidecar directory, separating what it says from what it could
 * not say.
 *
 * Three outcomes, and keeping them apart is the entire point:
 *
 * - `readable: false` — the directory could not be opened. Nothing is known.
 * - `problems` — a subagent is visibly there but unidentifiable: its meta is
 *   absent, unreadable, half written, not an object, or carries no readable
 *   `description`. We know something ran and cannot know whether it was the
 *   reviewer. Each carries a `why` and the `at` its transcript still supplies,
 *   so a caller can ignore one that provably belongs to a different Forge
 *   session rather than going blind over a neighbour's corrupt file.
 * - `records` — one per dispatch whose description is exactly a prescribed
 *   `forge-review <unit>`.
 * - `unlabelled` — identifiable dispatches that say they are not reviewers.
 *   The only real negative of the four, and the one a caller counts to tell
 *   "the convention is not in use" from "nothing ran".
 *
 * Only prescribed dispatches become records: this answers "was a reviewer
 * dispatched for unit X", not "what subagents ran". `readSubagents` in
 * `transcript.mjs` answers the latter and this does not duplicate it.
 *
 * A record whose transcript is missing keeps `requests: 0` and `at: null`
 * rather than being dropped. **This is not what a declined dispatch looks
 * like** — an earlier comment here claimed it was, and the claim is refuted:
 * measured over the 420 sidecar metas on this machine (2026-07-29), 0 lack a
 * transcript, and all five carrying `stoppedByUser` have transcripts of 49-423
 * lines with parsable first timestamps, because an operator stops a dispatch
 * *after* it has started. The shape means a pruned `.jsonl` beside a surviving
 * meta, and it is kept because a reviewer that demonstrably existed must not
 * vanish into silence.
 *
 * `options.filter` is an optional predicate applied to each raw transcript line
 * before any counting, matching `readSubagents`, for a caller that wants only
 * part of a sidecar. It must not throw. A record whose every line is filtered
 * out still appears, with zero counts. Note that `reviewEvidence` below does
 * *not* use it: attribution is by the session id in the description, so there
 * is nothing for a line filter to decide.
 *
 * @param {string | null | undefined} sidecarDir
 * @param {{ filter?: (line: Record<string, any>) => boolean }} [options]
 * @returns {{ readable: boolean, reason: string | null,
 *   records: { agentId: string, unit: string, requests: number,
 *     stoppedByUser: boolean, at: string | null }[],
 *   unlabelled: { agentId: string, at: string | null }[],
 *   problems: { agentId: string, at: string | null, why: string }[] }} four
 *   outcomes, not three: `records` (prescribed, sorted by `agentId`),
 *   `unlabelled` (identifiable and not a reviewer), `problems` (visibly there
 *   and unidentifiable, `why` naming which), and `readable: false` (could not
 *   look at all). Collapsing any pair of these is the defect class this module
 *   exists to end.
 */
function scanSidecar(sidecarDir, options) {
  if (typeof sidecarDir !== 'string' || !sidecarDir) {
    return { readable: false, reason: 'no sidecar directory given', records: [], problems: [] };
  }
  const filter = typeof options?.filter === 'function' ? options.filter : null;
  /** @type {string[]} */
  let names;
  try {
    names = fs.readdirSync(sidecarDir);
  } catch (error) {
    // NOT `[]`. An empty array here would be indistinguishable from an empty
    // directory, and the caller would answer "I checked and no reviewer ran"
    // for a directory it never managed to open.
    return {
      readable: false,
      reason: `sidecar directory could not be read: ${error?.code ?? error?.message ?? error}`,
      records: [],
      problems: [],
    };
  }

  /** @type {Map<string, { transcript: string | null, meta: string | null }>} */
  const agents = new Map();
  for (const name of names) {
    const metaMatch = /^agent-(.+)\.meta\.json$/.exec(name);
    const transcriptMatch = /^agent-(.+)\.jsonl$/.exec(name);
    const agentId = (metaMatch ?? transcriptMatch)?.[1];
    if (!agentId) continue;
    const entry = agents.get(agentId) ?? { transcript: null, meta: null };
    if (metaMatch) entry.meta = path.join(sidecarDir, name);
    else entry.transcript = path.join(sidecarDir, name);
    agents.set(agentId, entry);
  }

  const records = [];
  /** @type {{ agentId: string, at: string | null }[]} */
  const problems = [];
  /** @type {{ agentId: string, at: string | null }[]} */
  const unlabelled = [];
  for (const [agentId, { transcript, meta }] of agents) {
    // Counted through the same collapse `transcript.mjs` owns, never
    // re-derived: a request is restated once per content block, and anything
    // that counts lines instead inflates by 2–3×.
    const all = transcript ? readJsonl(transcript) : [];
    const lines = filter ? all.filter((line) => filter(line)) : all;
    const at = earliest(lines);

    const parsed = readMeta(meta);
    if (!parsed.ok) {
      // A subagent we can see but cannot identify. Its transcript still places
      // it in time, which is what lets a caller ignore one belonging to a
      // different Forge session instead of going blind over a neighbour's
      // corrupt file.
      problems.push({ agentId, at, why: 'could not be read' });
      continue;
    }

    // THE THIRD SITE OF THE COLLAPSE. `unitOf` answers null for two different
    // questions — "this description says it is not a review dispatch" and
    // "there is no description to read" — and only the first is a negative.
    // A meta that parses but whose `description` is absent, empty or not a
    // string is a dispatch we cannot identify, exactly like an unreadable one,
    // and letting it fall through to `continue` reported "no reviewer ran".
    //
    // Unreachable on today's corpus: `description` is a non-empty string on
    // every real meta. It is kept because the field is an undocumented host
    // detail and `host.mjs` states these shapes are not a contract — a release
    // that renamed or nested it would make every dispatch unidentifiable at
    // once, and the gate would then refuse everything with nothing to diagnose.
    const description = parsed.meta.description;
    if (typeof description !== 'string' || !description.trim()) {
      problems.push({ agentId, at, why: 'has no readable description' });
      continue;
    }

    const named = unitOf(description);
    if (named === null) {
      // Identifiable, and it says it is not a reviewer. A real negative, and
      // the only one this loop produces.
      unlabelled.push({ agentId, at });
      continue;
    }

    records.push({
      agentId,
      unit: named.unit,
      // Which Forge session dispatched it, or null for the older two-word form
      // that named no session. Null is not "mine" and not "someone else's" — it
      // is unattributable, and the caller must not resolve it either way.
      forgeSessionId: named.forgeSessionId,
      requests: aggregateTokens(usageByRequest(lines)).requests,
      // Only a literal `true` counts. Measured across every meta on this
      // machine (420, 2026-07-29) the host writes this key *only* when it
      // fires — 5 present, all `true`, never `false` — so an absent key is an
      // ordinary dispatch and anything else is not the host's own record of a
      // refusal.
      stoppedByUser: parsed.meta.stoppedByUser === true,
      at,
    });
  }

  // Sorted so persisted evidence is byte-stable across runs: readdir order is
  // the filesystem's business, not a contract.
  records.sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
  return { readable: true, reason: null, records, problems, unlabelled };
}

/**
 * One record per reviewer dispatch in a host sidecar directory.
 *
 * The array-returning face of the module-private `scanSidecar`, kept because a
 * caller reading a single sidecar directory wants the records and nothing else.
 *
 * **This function cannot express "I could not look".** An unreadable directory,
 * an unreadable meta and a directory holding no reviewer all come back as an
 * absent record — the collapse the rest of this module exists to avoid. That is
 * tolerable here only because the one caller that must not make that mistake,
 * `reviewEvidence`, is inside this module and uses `scanSidecar` directly. Any
 * future caller outside it that needs the distinction must be given the scan,
 * by exporting it, rather than inferring absence from an empty array.
 *
 * @param {string | null | undefined} sidecarDir
 * @param {{ filter?: (line: Record<string, any>) => boolean }} [options]
 * @returns {{ agentId: string, unit: string, requests: number,
 *   stoppedByUser: boolean, at: string | null }[]} sorted by `agentId`; `[]`
 *   for a directory that is missing, unreadable or not a directory
 */
export function readReviewerSidecars(sidecarDir, options) {
  return scanSidecar(sidecarDir, options).records;
}

/**
 * The answer shape for "I could not look".
 *
 * Always carries an empty `units`, so a caller that reads `units` without
 * checking `available` sees no dispatches rather than a crash — but `available`
 * and `reason` are what distinguish this from having looked and found nothing.
 *
 * @param {string} reason
 * @returns {{ available: false, units: Record<string, never>, reason: string }}
 */
function unavailable(reason) {
  // `seen` and `prescribed` are zero here in the same sense `units` is empty:
  // placeholders that keep the shape uniform, not measurements. Nothing was
  // counted, because nothing could be. Read `available` before any of them.
  return { available: false, units: Object.create(null), seen: 0, prescribed: 0, reason };
}



/**
 * What the host recorded about reviewer dispatches for one Forge session.
 *
 * ATTRIBUTION — binding says which *files*; the session id says which
 * *dispatches*. A host session routinely outlives the Forge session that
 * started it: run `forge new` twice in one Claude Code session and both bind to
 * the same transcript and the same sidecar directory. A dispatch is kept only
 * if its description names *this* session — `forge-review <unit>
 * <forge-session-id>`, which `forge review-label` prints.
 *
 * THIS REPLACED A TIME WINDOW, AND THE HISTORY IS THE ARGUMENT. Records used to
 * be kept when they started inside `[session.createdAt, now]`. That is only
 * sound at the lower edge, and three independent review rounds each defeated a
 * patch on the upper one: a session created *later* dispatches *earlier* than
 * this one's transition; a session that has reached `done` can still dispatch,
 * because `phase: done` ends the Forge session and not the conversation; and a
 * neighbour that ran `forge cleanup` — which `phases/finish.md` prescribes on
 * the line after `forge phase done` — leaves nothing on disk to find. Each one
 * credited a neighbour's reviewer to a session whose own final review was a
 * self-check, and passed it through the money/auth gate at score 93.
 *
 * So attribution is now an equality test and there is no window to skew, no
 * sibling to search for, and no index of who shared a conversation to keep. Do
 * not reintroduce a time filter here: a reviewer legitimately runs past the
 * moment collection starts, and a record naming this session is this session's
 * whenever it ran.
 *
 * A record whose description names *no* session — the older two-word form —
 * makes the whole answer unavailable rather than being quietly skipped or
 * quietly counted. It cannot be credited here and it cannot be dismissed, since
 * it may well be ours; the census then reads the prose, which can lose a grade
 * but never refuse work. `readReviewerSidecars` still returns that record,
 * because a caller reading one directory is not the one deciding attribution.
 *
 * `available: false` means "I could not tell" and never "no reviewer ran".
 * `available: true` with an empty `units` is the second answer and must stay
 * distinguishable from the first: it is the verdict "the host recorded this
 * session and no reviewer was dispatched", which the census is entitled to act
 * on, whereas absence of evidence must fall back to the prose rule and must
 * never by itself refuse work.
 *
 * THE THIRD ANSWER — `seen` and `prescribed` exist because an empty `units` is
 * still ambiguous, and the ambiguity is not academic. Almost no dispatch on a
 * real machine yet carries the label, so `prescribed === 0` overwhelmingly
 * means "nobody has adopted the convention here", not "nobody reviewed" — and a
 * census reading it as the latter would refuse essentially every session at the
 * money/auth gate. The corpus figure lives in one place, `review-census.mjs`'s
 * adoption-gate note, because it goes stale daily and four copies of it went
 * stale differently. `seen` counts every identifiable dispatch in this
 * conversation, ours or not, so a caller can separate:
 *
 *   available === false          nothing is known — READ THIS FIRST
 *   seen > 0, prescribed === 0   subagents ran, none labelled for this session
 *   seen === 0                   nothing ran in this conversation at all
 *
 * `seen` and `prescribed` are `0` on an unavailable answer as placeholders, not
 * as measurements, and no numeric value could distinguish the two — "looked and
 * found nothing" and "could not look" are genuinely the same count. `available`
 * is the discriminator. A caller that reads the tallies without it gets `self`
 * for a session nobody could measure.
 *
 * A dispatch that is *unidentifiable* makes the answer unavailable: it may be
 * this session's own reviewer, and once any of our dispatches is on record a
 * missing `final` refuses the change.
 *
 * Never throws.
 *
 * @param {{ session?: Record<string, any>, env?: Record<string, string | undefined>,
 *   configDir?: string }} [options] `configDir` and `env` are passed through to
 *   `findTranscripts`. Unknown keys are ignored — `now` and `sessionsDir` were
 *   both inputs to the attribution *inference* and are no longer read, since a
 *   dispatch record now names the session that made it.
 * @returns {{ available: boolean,
 *   units: Record<string, { dispatched: number, stopped: number, requests: number,
 *     maxRequests: number }>,
 *   seen: number, prescribed: number, reason?: string }} `units` is
 *   prototype-less and keyed by review unit. `requests` is the sum across all of
 *   the unit's dispatches, stopped or not; `maxRequests` is the largest of any
 *   single dispatch the operator did *not* stop, and `0` when every one was
 *   stopped. `seen` is every identifiable
 *   dispatch in this host conversation and `prescribed` only those naming *this*
 *   session, so `prescribed <= seen` always. `reason` is present only when `available` is
 *   false, and `units`, `seen` and `prescribed` are then placeholders — zero
 *   because nothing could be counted, not because nothing was there.
 */
export function reviewEvidence(options) {
  const opts = options && typeof options === 'object' ? options : {};
  try {
    const session = opts.session && typeof opts.session === 'object' ? opts.session : {};
    const host = session.host && typeof session.host === 'object' ? session.host : {};
    const sessionIds = (Array.isArray(host.sessionIds) ? host.sessionIds : []).filter(
      (id) => typeof id === 'string' && id,
    );
    if (sessionIds.length === 0) {
      return unavailable('no host session bound to this Forge session — nothing to read');
    }

    const { found: bound, unreadable } = findTranscripts(sessionIds, {
      configDir: opts.configDir,
      env: opts.env,
    });
    if (bound.length === 0) {
      return unavailable(
        `no transcript on disk for host session ${sessionIds.join(', ')} — pruned or written elsewhere`,
      );
    }

    // A binding this module could only read in part must not decide the gate.
    // `findTranscripts` distinguishes a `subagents` path it could not stat, or
    // one that exists and is not a directory, from the ordinary case of no
    // subagents dispatched at all (the ENOENT split) — and reports the former
    // here by session id and path rather than folding it into `sidecarDir:
    // null`. This must be checked before the `sidecarDirs.length === 0` guard
    // below: an unreadable sidecar sitting beside one or more resolvable ones
    // would otherwise slip past it and answer confidently from the readable
    // half, which is the exact defect that guard's own comment used to
    // describe.
    if (unreadable.length > 0) {
      const detail = unreadable
        .map((u) => `host session ${u.sessionId} (${u.path}): ${u.reason}`)
        .join('; ');
      return unavailable(`could not read host session data — ${detail}`);
    }

    const sidecarDirs = bound
      .map((entry) => entry.sidecarDir)
      .filter((dir) => typeof dir === 'string' && dir);
    // THE FIX ABOVE, AND ITS DELIBERATE LIMIT. This guard used to describe a
    // known hole: a `subagents` path that could not be stat-ed, or that existed
    // and was not a directory, came back from `findTranscripts` as
    // `sidecarDir: null` — byte-identical to a session that dispatched no
    // subagents. A session bound to two host sessions (ordinary; `bindHost`
    // appends an id on resume) whose second such path was blocked still
    // answered confidently from the first, and a reviewer dispatched in the
    // unreachable half was simply absent from `units` — a confidently wrong
    // positive, worse than the silent negatives the rest of this module exists
    // to prevent. The `unreadable` guard above now closes that: `host.mjs`'s
    // ENOENT split reports a blocked or non-directory sidecar by name and path
    // instead of collapsing it into absence, and this module refuses to answer
    // rather than reading only the resolvable half.
    //
    // What this did NOT buy, on purpose, is the pruned-transcript residual. A
    // session bound to two host sessions where the *older* transcript is
    // genuinely gone from disk — pruned, not blocked — still answers from the
    // surviving newer one, and a reviewer that ran in the pruned half stays
    // invisible to this module. The Scenario this spec requires ("A transcript
    // that was pruned, not blocked") demands exactly that answer stay
    // available: reporting unavailable whenever `bound.length <
    // sessionIds.length`, which would also catch the residual, is the
    // in-module half-fix this comment rejected before the ENOENT split
    // existed, and rejects again now — it would make *every* resumed session
    // unavailable the instant its older transcript ages out of the host's
    // retention window, which is a matter of days, not an edge case. The
    // residual's real fix is a dispatch-time stamp written into the review
    // artefact itself, tracked as F12: that stamp is read from the artefact
    // this module is verifying, not reconstructed from a transcript that may
    // no longer be on disk, so it survives the pruning this module cannot see
    // past.
    if (sidecarDirs.length === 0) {
      // The host wrote no `subagents/` directory. That is *probably* a session
      // that dispatched nothing, but "probably" is not evidence: the directory
      // is also absent when the host never wrote sidecars at all. Reported as
      // "could not tell" so the census falls back to the prose rule, which is
      // the side of this call that cannot refuse correct work.
      return unavailable(
        `no sidecar directory beside the transcript for host session ${sessionIds.join(', ')} — no dispatch record to read`,
      );
    }

    // WHO THIS SESSION IS. Every dispatch record names the Forge session that
    // made it, so attribution is an equality test rather than an inference. The
    // time window this used to rely on is gone with the inference: a window
    // over a *host* conversation cannot separate two Forge sessions inside it,
    // which is what three review rounds each rediscovered.
    const id = typeof session.id === 'string' && session.id ? session.id : null;
    if (id === null) {
      return unavailable('session has no id — a dispatch record cannot be matched to it');
    }

    /** @type {Record<string, { dispatched: number, stopped: number, requests: number,
     *   maxRequests: number }>} */
    // Prototype-less: the keys come from host-supplied description text. The
    // reachable collision is `constructor` — it is all-lowercase, so it
    // survives the unit's normalisation, where `__proto__` cannot (a leading
    // `_` is not a legal unit character) and `toString` cannot (it lower-cases
    // to a harmless `tostring`). On an ordinary object `units.constructor ??=`
    // finds the inherited `Object` *constructor function*, skips the
    // assignment, and adds the counts to that function — so the unit vanishes
    // from the table and `Object.dispatched` becomes NaN. Note it is the
    // constructor that is polluted, not `Object.prototype`: ordinary objects do
    // not gain a `dispatched` property, which is why that is not the thing to
    // assert. Same defence as `byModel` in `transcript.mjs`.
    const units = Object.create(null);
    let seen = 0;
    let prescribed = 0;

    for (const dir of sidecarDirs) {
      const scan = scanSidecar(dir);
      if (!scan.readable) {
        return unavailable(`${scan.reason} — cannot tell whether a reviewer was dispatched`);
      }

      // AN UNIDENTIFIABLE DISPATCH IS UNAVAILABILITY, and it no longer matters
      // whether it can be placed in time: a meta we cannot read might be *this*
      // session's `final` reviewer, and once any of our dispatches is on record
      // a missing `final` reads as "no outside reader" and refuses. Formerly
      // one outside the window was skipped as provably a neighbour's; with no
      // window there is nothing to prove that with, and guessing is how a
      // confidently wrong answer reaches the gate.
      for (const problem of scan.problems) {
        return unavailable(
          `dispatch record for agent ${problem.agentId} ${problem.why} — cannot tell whether it was this session's reviewer`,
        );
      }

      // Identifiable and not a review dispatch. Counted so the caller can tell
      // "nobody here labels their reviewers" from "nothing ran at all" — the
      // adoption gate, unchanged in meaning.
      seen += scan.unlabelled.length;

      for (const record of scan.records) {
        // A review dispatch happened in this conversation, whoever made it.
        seen += 1;

        if (record.forgeSessionId === null) {
          // The older two-word form. It names no session, so it cannot be
          // credited to this one — and it cannot be dismissed either, because
          // it may well be ours. Reporting "no reviewer ran" over it is the
          // collapse this module exists to prevent; counting it is the
          // over-credit the session id was added to end. The honest answer is
          // that we cannot tell, and the census then reads the prose — the side
          // of this call that can only lose a grade, never refuse work.
          return unavailable(
            `dispatch record for agent ${record.agentId} names no Forge session — it predates the labelled convention and cannot be attributed`,
          );
        }

        // A neighbour's reviewer in the same conversation is now simply a
        // different string. It counts as adoption, never as ours.
        if (record.forgeSessionId !== id) continue;

        prescribed += 1;
        const bucket = (units[record.unit] ??= {
          dispatched: 0,
          stopped: 0,
          requests: 0,
          maxRequests: 0,
        });
        bucket.dispatched += 1;
        if (record.stoppedByUser) bucket.stopped += 1;
        bucket.requests += record.requests;
        // THE BUSIEST SINGLE DISPATCH, AND WHY IT IS NOT THE SUM ABOVE. A
        // caller asking "did a reviewer actually do any work" cannot read
        // `requests`: ten throwaway dispatches for one unit add up to whatever
        // number it is compared against, so a sum is assembled out of pieces
        // that individually reviewed nothing. A maximum cannot be — some one
        // dispatch has to have done the work.
        //
        // STOPPED RECORDS ARE EXCLUDED, and that is load-bearing rather than
        // tidiness. `review-census.mjs` grades a unit independent when
        // `stopped < dispatched`, so an operator-killed dispatch beside a token
        // one that ran is already an "independent" unit — and a maximum that
        // counted the killed dispatch's requests would let it vouch for the
        // token one, which is precisely the pair the grade cannot separate. A
        // unit whose every dispatch was stopped therefore reports 0, while
        // `requests` above still says the tokens were burnt.
        //
        // Measurement only. The floor this is compared against lives in the
        // census: this module reports counts, it does not decide what count is
        // enough.
        if (!record.stoppedByUser && record.requests > bucket.maxRequests) {
          bucket.maxRequests = record.requests;
        }
      }
    }

    // No `reason` key at all on the way out: an empty `units` here is a
    // measurement, not an excuse, and a caller must be able to tell the two
    // apart by presence alone.
    return { available: true, units, seen, prescribed };
  } catch (error) {
    return unavailable(`review evidence collection failed: ${error?.message ?? error}`);
  }
}
