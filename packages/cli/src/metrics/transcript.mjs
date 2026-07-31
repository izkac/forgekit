/**
 * Read the host's JSONL transcripts and turn them into token counts.
 *
 * `metrics/host.mjs` answers *which* transcript files belong to a session;
 * this module answers *what they cost*. It reads only counts and identifiers —
 * model slugs, request ids, token totals. Prompt text, model responses and
 * tool-call inputs stay in the file and never reach a return value here, so
 * nothing this module produces can leak content into a persisted metric.
 *
 * THE TRAP — read before changing anything below.
 *
 * The host writes **one transcript line per content block** of a single
 * assistant reply. A reply with a thinking block, a text block and two tool
 * calls becomes four `assistant` lines, and every one of them repeats the same
 * `requestId` and the same `message.id`. Measured on archived transcripts:
 * 612 assistant lines for 374 requests, 351 for 204. Summing usage across
 * lines therefore inflates every token number by 2–3×, and the inflated figure
 * still looks entirely plausible; nothing downstream would catch it.
 * `usageByRequest` collapses to one entry per request and takes the usage
 * exactly once. Do not "fix" it into a sum.
 *
 * What those lines repeat is *nearly* the whole `usage` object — see the
 * second trap on `usageByRequest`, because `output_tokens` is the exception
 * and getting that wrong costs more than the inflation this paragraph warns
 * about. (Cite only archived transcripts in measurements like these. An
 * earlier draft quoted 227 lines for 95 requests from the session that was
 * writing the file at the time; it reads 250 for 106 today and will not
 * reproduce for anyone.)
 *
 * The same duplication reaches `aggregateTools`, which walks `message.content`
 * rather than collapsed requests: a `tool_use` block can be restated on more
 * than one line, so the block's own `id` is the call and the block is not.
 * Counting blocks would inflate call counts exactly as summing lines inflates
 * tokens. Measured across all 479 transcripts on this machine no id is in fact
 * repeated today — but 7 assistant lines already carry more than one content
 * block, so the one-block-per-line shape the counting would rely on is not a
 * contract, and the id is free to be correct either way.
 *
 * Sizing, for whoever wires this into a command: the largest real transcript
 * here is 57.5 MB (4110 lines, 962 requests) and reading it whole, collapsing
 * it and counting its tools takes ~300 ms at ~230 MB RSS. Reading the file in
 * one go is fine; there is no need for a streaming parser.
 *
 * Parent transcripts contain **zero** `isSidechain` requests — subagent work
 * lives only in the `subagents/` sidecars — so a caller may add a parent's
 * totals to its subagents' without double-counting.
 *
 * Everything degrades instead of throwing — telemetry is advisory and must
 * never fail a command. `readLedger` in `../ledger.mjs` is the precedent.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Parse a JSONL file into objects, one per line.
 *
 * Unparseable lines are skipped rather than fatal: a transcript is appended to
 * live, so the last line of a session killed mid-write is routinely half
 * written, and that must not hide the 500 good lines above it. That is
 * line-level damage, tolerated by design; `error` below is about the file as
 * a whole being unreadable, which is not tolerated silently.
 *
 * `error` is `null` on success — a genuinely empty file included, since
 * reading nothing is still a successful read — and `{ code, message }` from
 * the thrown error otherwise, `ENOENT` included. This is a deliberate
 * divergence from `findTranscripts` in `host.mjs`, which treats `ENOENT` as
 * routine: that function *searches*, probing every project directory for
 * every session id, so nearly every probe misses and absence is the routine
 * outcome there. This function *reads a path located moments ago* — absence
 * here is a race or a bug, never routine — so the searching layer's
 * ENOENT-is-ordinary policy does not transfer to this reading layer. Do not
 * "fix" this into agreement with `host.mjs`.
 *
 * @param {string} filePath
 * @returns {{ lines: Record<string, any>[], error: { code: string, message: string } | null }}
 *   `lines` is `[]` whenever `error` is set; malformed individual lines are
 *   still skipped rather than failing the whole read.
 */
export function readJsonl(filePath) {
  /** @type {string} */
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    // `err.code` and `err.message` are present on every real fs error, but the
    // access must survive an exotic throw that carries neither — hence `?.`
    // and, for message, `||` rather than `??` so an empty string still falls
    // through to `String(err)` instead of standing as the whole answer.
    return { lines: [], error: { code: err?.code, message: err?.message || String(err) } };
  }

  /** @type {Record<string, any>[]} */
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A half-written line from a killed process must not hide the rest.
    }
  }
  return { lines: out, error: null };
}

/**
 * A token count, or 0 for anything that is not a usable one. The host has
 * never written a negative or non-numeric count, but a metric that silently
 * becomes `NaN` poisons every total downstream, so nonsense is floored.
 *
 * @param {unknown} value
 * @returns {number}
 */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Collapse assistant transcript lines to one entry per request.
 *
 * The dedupe key is `requestId`, falling back to `message.id`; a line carrying
 * neither is its own request, counted once. 39 real assistant lines carry no
 * `requestId`, so the fallback is live rather than defensive, and no
 * `message.id` was ever seen spanning two requests, so it is safe as a key.
 *
 * THE SECOND TRAP — the **last** line of a request wins, not the first.
 *
 * A request's lines do not merely restate one usage object. `input`,
 * `cache_read` and `cache_creation` are byte-identical across them, but
 * `output_tokens` is not: the first line carries a *preliminary* count written
 * before the reply has settled — typically 3 to 7 — and a later line carries
 * the real one. A real example, `req_011CdHbph3J3cZJVF9w1Qiz4`, goes 4 → 131
 * with every other field holding still.
 *
 * Measured over the 479 transcripts on this machine at the time of writing,
 * grouped exactly as this function groups: of 28,719 multi-line requests,
 * 11,510 disagree on output. All 11,510 **understate**; not one overstates.
 * First-line-wins drops 8,056,090 output tokens — 28.6% of the true total —
 * and it falls almost entirely on subagents (368 of 371 sidecars affected, 0
 * of 108 parent transcripts), which is exactly why a parent-only spot-check
 * pronounced it correct. Those totals drift as the corpus grows; the shape
 * does not. Last-line-wins and taking the maximum agreed on **every** request
 * in the corpus, so the settled value is unambiguous; last-wins is preferred
 * because it states a rule — the figure the host settled on — rather than a
 * heuristic that happens to coincide.
 *
 * The other scalars (`model`, `effort`, `version`, `isSidechain`) come from
 * that same settled line, so one entry never mixes facts from two lines; no
 * request in the corpus disagrees with itself on any of them, so this costs
 * nothing and buys coherence. `timestamp` is the exception and is taken from
 * the **first** line: a request belongs in time where it started, and
 * first-seen order — which the phase join relies on — must not contradict the
 * stamp the entry carries.
 *
 * Only counts and identifiers cross this boundary: `message.content` — the
 * prompt text, response prose and tool-call inputs — is never read.
 *
 * @param {Record<string, any>[]} lines
 * @returns {{ requestId: string | null, model: string | null, timestamp: string | null,
 *   effort: string | null, version: string | null, isSidechain: boolean,
 *   usage: { input: number, output: number, cacheRead: number, cacheCreate: number } }[]}
 */
export function usageByRequest(lines) {
  if (!Array.isArray(lines)) return [];

  /** @type {Map<string, number>} requestId → its slot in `entries` */
  const slotOf = new Map();
  /** @type {any[]} */
  const entries = [];

  for (const line of lines) {
    if (!line || typeof line !== 'object' || line.type !== 'assistant') continue;
    const message = line.message;
    if (!message || typeof message !== 'object') continue;
    const usage = message.usage;
    if (!usage || typeof usage !== 'object') continue;

    const requestId =
      typeof line.requestId === 'string' && line.requestId
        ? line.requestId
        : typeof message.id === 'string' && message.id
          ? message.id
          : null;
    const entry = {
      requestId,
      model: typeof message.model === 'string' && message.model ? message.model : null,
      timestamp: typeof line.timestamp === 'string' && line.timestamp ? line.timestamp : null,
      effort: typeof line.effort === 'string' && line.effort ? line.effort : null,
      version: typeof line.version === 'string' && line.version ? line.version : null,
      isSidechain: line.isSidechain === true,
      usage: {
        input: count(usage.input_tokens),
        output: count(usage.output_tokens),
        cacheRead: count(usage.cache_read_input_tokens),
        cacheCreate: count(usage.cache_creation_input_tokens),
      },
    };

    // A later line of a request we have already placed supersedes it: it is
    // the same billed request restated with a settled output count. Written
    // back into the slot the first line claimed, so the request keeps its
    // chronological position, and keeping that line's timestamp with it.
    const slot = requestId === null ? undefined : slotOf.get(requestId);
    if (slot !== undefined) {
      entry.timestamp = entries[slot].timestamp;
      entries[slot] = entry;
      continue;
    }
    if (requestId !== null) slotOf.set(requestId, entries.length);
    entries.push(entry);
  }

  return entries;
}

/**
 * The value seen most often, first-seen winning a tie.
 *
 * @param {Map<string, number>} tally
 * @returns {string | null}
 */
function mostCommon(tally) {
  let best = null;
  let bestCount = 0;
  for (const [value, seen] of tally) {
    if (seen > bestCount) {
      best = value;
      bestCount = seen;
    }
  }
  return best;
}

/**
 * Roll deduplicated request entries up into one summary.
 *
 * Feed this the output of `usageByRequest`, never raw transcript lines — the
 * dedupe has to have happened already or every total here is inflated.
 *
 * A request with no model slug lands in `unknown` rather than being dropped:
 * it cost tokens, so it must still appear in the totals. `hostVersion` is the
 * version seen most often, since a long session can span a host upgrade and
 * recording it is what makes a future format break diagnosable.
 *
 * @param {ReturnType<typeof usageByRequest>} entries
 * @returns {{ requests: number,
 *   tokens: { input: number, output: number, cacheRead: number, cacheCreate: number },
 *   byModel: Record<string, { requests: number, input: number, output: number, cacheRead: number, cacheCreate: number }>,
 *   hostVersion: string | null, efforts: Record<string, number> }}
 *   **`byModel` and `efforts` are prototype-less** (`Object.create(null)`), as
 *   is `tools` from `aggregateTools`, because their keys are host-supplied
 *   strings — see the note on the maps themselves. For an in-process caller
 *   this means `Object.getPrototypeOf(byModel) === null`, so `byModel[slug]`,
 *   `in`, `Object.hasOwn`, `Object.entries` and spread all work as usual but
 *   `byModel.hasOwnProperty(...)` throws `TypeError: not a function` — use
 *   `Object.hasOwn(byModel, slug)`. Serialising is unaffected: these appear as
 *   ordinary objects in JSON, so anything persisted or re-read is normal.
 */
export function aggregateTokens(entries) {
  const summary = {
    requests: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    // Prototype-less: the keys are host-supplied model slugs and effort names.
    // On an ordinary object a slug of `__proto__` makes `??=` see the inherited
    // prototype, skip the assignment, and add the tokens to Object.prototype
    // instead — the bucket disappears from the totals and every object in the
    // process gains a `requests` property and an `input` of NaN. `toString`
    // and `constructor` break the same way. A bare table inherits nothing, so
    // no key can collide.
    /** @type {Record<string, any>} */
    byModel: Object.create(null),
    /** @type {string | null} */
    hostVersion: null,
    /** @type {Record<string, number>} */
    efforts: Object.create(null),
  };
  if (!Array.isArray(entries)) return summary;

  /** @type {Map<string, number>} */
  const versions = new Map();

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const usage = entry.usage;
    if (!usage || typeof usage !== 'object') continue;

    summary.requests += 1;
    const model = typeof entry.model === 'string' && entry.model ? entry.model : 'unknown';
    const bucket = (summary.byModel[model] ??= {
      requests: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreate: 0,
    });
    bucket.requests += 1;

    for (const field of ['input', 'output', 'cacheRead', 'cacheCreate']) {
      const tokens = count(usage[field]);
      summary.tokens[field] += tokens;
      bucket[field] += tokens;
    }

    if (typeof entry.version === 'string' && entry.version) {
      versions.set(entry.version, (versions.get(entry.version) ?? 0) + 1);
    }
    if (typeof entry.effort === 'string' && entry.effort) {
      summary.efforts[entry.effort] = (summary.efforts[entry.effort] ?? 0) + 1;
    }
  }

  summary.hostVersion = mostCommon(versions);
  return summary;
}

/**
 * Count tool calls and tool failures across raw transcript lines.
 *
 * Feed this raw lines, not `usageByRequest` output — the calls live in
 * `message.content`, which the dedupe deliberately never reads.
 *
 * Calls come from `tool_use` blocks on `assistant` lines, failures from
 * `tool_result` blocks on `user` lines. A result names only its `tool_use_id`,
 * so the id → name map built from the calls is what attributes a failure to a
 * tool.
 *
 * Only an explicit `is_error: true` is a failure. The host writes `false` on
 * some results and omits the field entirely on others — measured across every
 * transcript on this machine: 23780 `false`, 22812 absent, 824 `true`, and not
 * one literal `null` — so treating anything falsy-but-present as suspicious
 * would report a ~50% failure rate for a session that failed nothing.
 *
 * Neither a `tool_use` `input` nor a `tool_result` `content` is ever read:
 * those hold command strings and file contents, and this output is persisted.
 *
 * **Contract for callers:** `errors.errorResults` is the authoritative failure
 * count, and the per-tool `errors` need not add up to it. A `tool_result`
 * whose `tool_use_id` matches no call in these lines — which happens when a
 * transcript begins mid-exchange, as a resumed session's does — counts in
 * `errors` but belongs to no tool. Sum the buckets to cross-check a total and
 * they can come up short; use `errors.errorResults` for the total and the
 * buckets only for the split.
 *
 * @param {Record<string, any>[]} lines
 * @returns {{ tools: Record<string, { calls: number, errors: number }>,
 *   errors: { toolResults: number, errorResults: number, rate: number } }}
 *   `tools` is keyed by tool name, prototype-less; unnamed calls land under
 *   `"unknown"`. `errors.rate` is `errorResults / toolResults` to 4 decimal
 *   places, and `0` — never `NaN` — when nothing ran.
 */
export function aggregateTools(lines) {
  // Prototype-less for the same reason as `byModel` — see `aggregateTokens`.
  // Tool names come from the host, and a tool named `__proto__` or `toString`
  // would otherwise vanish from the table and write its counts onto a shared
  // object.
  /** @type {Record<string, { calls: number, errors: number }>} */
  const tools = Object.create(null);
  const errors = { toolResults: 0, errorResults: 0, rate: 0 };
  if (!Array.isArray(lines)) return { tools, errors };

  /** @type {Map<string, string>} tool_use id → tool name */
  const nameById = new Map();
  /** @type {{ id: string | null, failed: boolean }[]} */
  const results = [];
  /** @type {Set<string>} tool_use ids already counted as a call */
  const counted = new Set();

  for (const line of lines) {
    if (!line || typeof line !== 'object') continue;
    const content = line.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;

      if (line.type === 'assistant' && block.type === 'tool_use') {
        const name = typeof block.name === 'string' && block.name ? block.name : 'unknown';
        const id = typeof block.id === 'string' && block.id ? block.id : null;
        // The id is the call; the block is only a re-statement of it. A block
        // with no id at all is its own call, exactly as usageByRequest treats a
        // line with no requestId.
        if (id !== null) {
          if (counted.has(id)) continue;
          counted.add(id);
          nameById.set(id, name);
        }
        const bucket = (tools[name] ??= { calls: 0, errors: 0 });
        bucket.calls += 1;
      }

      if (line.type === 'user' && block.type === 'tool_result') {
        const id =
          typeof block.tool_use_id === 'string' && block.tool_use_id ? block.tool_use_id : null;
        results.push({ id, failed: block.is_error === true });
      }
    }
  }

  // Attribution runs after every line is walked: the host has no rule that a
  // result follows its call in the same file, and a second pass costs nothing.
  for (const { id, failed } of results) {
    errors.toolResults += 1;
    if (!failed) continue;
    errors.errorResults += 1;
    // A result whose call is not in this file — a resumed session starts mid
    // exchange — counts in the totals but belongs to no tool. Inventing an
    // "unknown" bucket for it would report calls: 0, errors: 1 for a tool that
    // does not exist, which reads as a 100% failure rate on a phantom.
    const name = nameById.get(id);
    if (name !== undefined) tools[name].errors += 1;
  }

  // 0/0 is NaN, and NaN serialises to null and poisons every average built on
  // it. A session that ran no tools failed no tools.
  if (errors.toolResults > 0) {
    errors.rate = Math.round((errors.errorResults / errors.toolResults) * 10000) / 10000;
  }
  return { tools, errors };
}

/**
 * A non-empty string, or null. Metadata the host did not write is absent, not
 * empty — a record must not claim an agentType of `""`.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function text(value) {
  return typeof value === 'string' && value ? value : null;
}

/**
 * Parse an `agent-<id>.meta.json`. Any failure — missing, unreadable, half
 * written, or holding something that is not an object — yields no metadata
 * rather than losing the transcript that sits beside it.
 *
 * @param {string | null} filePath
 * @returns {Record<string, any>}
 */
function readMeta(filePath) {
  if (!filePath) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // `null` parses cleanly, so the catch below never sees it — and reading a
    // field off it throws. Arrays and scalars are equally not metadata.
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * One record per subagent dispatched during a session.
 *
 * A dispatch leaves two files in the session's `subagents/` directory — an
 * `agent-<id>.jsonl` transcript and an `agent-<id>.meta.json` — and either can
 * be missing: the meta is written when the agent is spawned and the transcript
 * as it runs, so a killed or pruned session leaves one without the other. Both
 * halves still produce a record, because "a subagent ran and we know only half
 * of it" is a fact worth keeping and a dropped record is an undercount nobody
 * can spot later.
 *
 * `model` in the meta is the **alias** the dispatch asked for (`opus`);
 * `message.model` in the transcript is the **slug** that actually answered
 * (`claude-opus-5`). Both are recorded because the comparison between them is
 * the only evidence of whether the model policy was honoured.
 *
 * The meta's `description` is deliberately not copied. It is free-form user
 * prose — task instructions, sometimes quoting the very content this module
 * exists to keep out of metrics — and these records are persisted to a file
 * that outlives the session. `agentType` answers "what was it" without it.
 *
 * Two fields beyond the counts are carried from the meta because a later join
 * needs them: `toolUseId` is the parent's `tool_use` id for the Task call that
 * spawned this agent, which is what ties a subagent record back to the line in
 * the parent transcript that dispatched it; `spawnDepth` distinguishes an
 * agent the session dispatched from one another agent dispatched. Both are
 * host identifiers, not content.
 *
 * `options.filter` is an optional predicate applied to each raw transcript
 * line before any counting, so a caller that only wants part of a sidecar —
 * `metrics/collect.mjs` windows them by timestamp, because a sidecar directory
 * belongs to the host session and outlives any one Forge session — gets
 * windowed records without re-implementing the transcript/meta pairing above.
 * It must not throw; a record whose every line is filtered out still appears,
 * with zero counts, exactly as a dispatch that wrote no transcript does.
 *
 * @param {string | null | undefined} sidecarDir
 * @param {{ filter?: (line: Record<string, any>) => boolean }} [options]
 * @returns {{ agentId: string, agentType: string | null, modelDispatched: string | null,
 *   modelResolved: string | null, toolUseId: string | null, spawnDepth: number | null,
 *   requests: number,
 *   tokens: { input: number, output: number, cacheRead: number, cacheCreate: number },
 *   errors: { toolResults: number, errorResults: number, rate: number } }[]}
 *   Sorted by `agentId`. Every metadata field is `null` when the meta is
 *   missing or unreadable; `modelResolved` is `null` when the transcript is.
 *   No `description` field is ever present — see above. The `errors` caveat in
 *   `aggregateTools` applies to each record's `errors`.
 */
export function readSubagents(sidecarDir, options) {
  if (typeof sidecarDir !== 'string' || !sidecarDir) return [];
  const filter = typeof options?.filter === 'function' ? options.filter : null;
  /** @type {string[]} */
  let names;
  try {
    names = fs.readdirSync(sidecarDir);
  } catch {
    return []; // missing, unreadable, or not a directory — advisory
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
  for (const [agentId, { transcript, meta }] of agents) {
    const parsed = readMeta(meta);
    // Read once: the token roll-up and the tool counts walk the same lines.
    // Advisory here too: a subagent record degrades to zero counts rather than
    // surfacing a transcript-unreadable error, same as it always has.
    const all = transcript ? readJsonl(transcript).lines : [];
    const lines = filter ? all.filter((line) => filter(line)) : all;
    const entries = usageByRequest(lines);
    const summary = aggregateTokens(entries);

    // The slug seen on the most requests. A subagent normally answers under
    // one model, but a fallback mid-run swaps it, and the majority is the
    // honest answer to "what ran this".
    /** @type {Map<string, number>} */
    const models = new Map();
    for (const entry of entries) {
      if (entry.model) models.set(entry.model, (models.get(entry.model) ?? 0) + 1);
    }

    records.push({
      agentId,
      agentType: text(parsed.agentType),
      modelDispatched: text(parsed.model),
      modelResolved: mostCommon(models),
      toolUseId: text(parsed.toolUseId),
      spawnDepth:
        typeof parsed.spawnDepth === 'number' && Number.isFinite(parsed.spawnDepth)
          ? parsed.spawnDepth
          : null,
      requests: summary.requests,
      tokens: summary.tokens,
      errors: aggregateTools(lines).errors,
    });
  }

  // Sorted so a persisted metrics file is byte-stable across runs: readdir
  // order is the filesystem's business, not a contract.
  return records.sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
}
