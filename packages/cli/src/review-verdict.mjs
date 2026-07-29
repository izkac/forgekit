/**
 * The review verdict frozen onto a session, read back.
 *
 * `set-phase.mjs` measures who wrote the final review once, at the `finish` /
 * `done` transition, and writes the answer to `session.json` as
 * `reviewVerdict`. Three consumers then read it instead of measuring again:
 * the money/auth done gate, the scorecard's 29-point cap, and the durable
 * `sessions.jsonl` digest.
 *
 * WHY THEY MUST NOT MEASURE AGAIN. The evidence is the host's own record of
 * subagents it dispatched, and it does not last — a one-day-old session on
 * this machine already has no surviving transcript. So a consumer that
 * remeasured would get a different answer later, or none.
 *
 * FREEZING IS NOT WHAT MAKES THE ATTRIBUTION CORRECT. An earlier design
 * attributed a dispatch by asking whether it started inside
 * `[session.createdAt, now]`, and three independent review rounds each defeated
 * a patch on that: a session created later dispatching earlier, a settled
 * session dispatching anyway, a cleaned-up neighbour leaving nothing on disk.
 * The dispatch description now carries the Forge session id, so a record names
 * the session that made it and crediting one is an equality test.
 *
 * What freezing buys is that the verdict survives the evidence being pruned.
 * It never bought soundness, and the paragraph above describes the design that
 * shipped before attribution moved into the dispatch description itself: a
 * record now names the Forge session that made it, so a `host` grade means the
 * host recorded a dispatch *this session* labelled. The timestamp window, and
 * the neighbour it could sweep in, are gone.
 *
 * WHY THIS IS A SEPARATE MODULE. The alternative was the same ten-line shape
 * check in three files, and a validation rule that exists three times is a
 * rule that will disagree with itself. `review-census.mjs` would be the
 * natural home, but it is deliberately ignorant of `session.json` — it takes a
 * directory and evidence, and knows nothing about where a verdict is stored.
 *
 * ABSENT IS NOT A VERDICT. Every session that finished before this change has
 * no `reviewVerdict` at all, and a hand-edited or half-written one is not a
 * measurement either. Both answer `null` here, which every caller reads as
 * "fall back to a live census" — never as a verdict of its own, and never as
 * grounds to refuse work.
 */

/** The verdicts a census can reach. `null` is "there is no final review". */
const FINAL = new Set(['independent', 'self']);

/**
 * The evidence grades, strongest first: `host` — the host's dispatch record;
 * `recorded` — reserved for a signed attestation, not yet produced by
 * anything; `inferred` — read off the review file's prose; `none` — there is
 * no final review to judge.
 */
const EVIDENCE = new Set(['host', 'recorded', 'inferred', 'none']);

/**
 * The verdict frozen on a session, or `null` when there is none to read.
 *
 * Strict on purpose. A `reviewVerdict` that does not have exactly the shape
 * `set-phase.mjs` writes did not come from a measurement, and guessing at a
 * partial one would put an invented verdict in front of a gate that refuses
 * work. Anything unrecognised falls back to a live census, which is the side
 * that cannot refuse correct work.
 *
 * Never throws: every caller is on the `forge phase done` path.
 *
 * @param {unknown} session a parsed `session.json` — or anything at all
 * @returns {{ final: 'independent' | 'self' | null,
 *   evidence: 'host' | 'recorded' | 'inferred' | 'none',
 *   stoppedByOperator: boolean } | null}
 */
export function frozenReviewVerdict(session) {
  if (!session || typeof session !== 'object') return null;
  const verdict = /** @type {any} */ (session).reviewVerdict;
  if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict)) return null;
  const { final, evidence, stoppedByOperator } = verdict;
  // `null` is a verdict — "there is no final review" — and is not the same as
  // a missing field, which is why membership is tested before nullness.
  if (final !== null && !FINAL.has(final)) return null;
  if (!EVIDENCE.has(evidence)) return null;
  if (typeof stoppedByOperator !== 'boolean') return null;
  return { final, evidence, stoppedByOperator };
}
