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

/**
 * The verdicts a census can reach. `null` is "there is no final review".
 *
 * Members of this set and of `EVIDENCE` must be **string literals**.
 * `review-verdict.test.mjs` parses both sets out of this file's source so that
 * adding a value cannot be silently left untested — and its regex harvests
 * quoted literals only. A member written as an identifier would be invisible to
 * it, and the suite would pass with the new value exercised by nothing.
 */
const FINAL = new Set(['independent', 'self']);

/**
 * The evidence grades, strongest first: `host` — the host's dispatch record;
 * `recorded` — a dispatch stamp `forge review-label` writes into
 * `reviews/dispatches.json` when it prints the label (F12), read back by rule
 * 5's census reading when host evidence cannot answer; `inferred` — read off
 * the review file's prose; `none` — there is no final review to judge.
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
 * NEVER THROWS, AND SHAPE ALONE DOES NOT BUY THAT. Every caller is on the
 * `forge phase done` path, where a throw out of this function loses the
 * transition — the gate never runs, the scorecard never caps, the digest is
 * never written. Rejecting an unrecognised shape is a `return null`, but a
 * *property read* can raise on its own: a getter on `reviewVerdict`, `final`,
 * `evidence`, `stoppedByOperator` or `unitOnRecord`, or a Proxy trap. So the
 * body is wrapped, and a throw answers `null` — the same answer as absent and
 * as malformed.
 *
 * `null` rather than a rethrow because a session this function cannot read is
 * a session it has no measurement for. What the consumers then do differs, and
 * the difference matters enough to state: `score.mjs` and `ledger.mjs` fall back
 * to a live census, while the money/auth gate in `set-phase.mjs` does not — it
 * writes a named warning to stderr and skips the floor, deliberately, for the
 * reasons recorded there. Neither is a refusal. Rethrowing would let an
 * unreadable field lose the transition outright, and a fabricated default
 * verdict would be worse still — it would put an invented measurement in front
 * of the gate. Between losing information and inventing it, this module loses it.
 *
 * The swallow is narrow by construction: the body performs no work but reading
 * five properties and testing them against two module-private sets (plus a
 * `typeof` check for `unitOnRecord`, which has no set of its own), so the only
 * throw it can absorb comes from the caller's own object.
 *
 * What that costs, stated exactly, because the looser claim was made here once
 * and is false: a bug in the checks below cannot become a wrong *answer* — every
 * path whose correct result is a verdict is asserted by value in
 * `review-verdict.test.mjs`, so a mistake this `catch` turned into `null`
 * reddens those tests. It can become a wrong *reason*. A check that threw
 * instead of returning `null` on a path that was going to answer `null` anyway
 * is invisible to the suite, because the answer is right either way.
 *
 * UNITONRECORD IS OPTIONAL, AND ABSENT IS NOT `FALSE`. It records whether the
 * pass that froze this verdict saw the deciding (`final`) review unit in the
 * host's dispatch record — a fact only `set-phase.mjs`'s freeze can supply,
 * and one it may not yet be writing for every verdict. A verdict with no
 * opinion on it must come back as `undefined`, not as an invented `false`:
 * `false` asserts "no unit was on record", which for a verdict nobody asked
 * the question is a fact nobody measured, not a fact that is true. That is
 * the exact absence-into-a-negative collapse a keep rule of the shape
 * `frozen.unitOnRecord ?? frozen.evidence === 'host'` is designed to avoid,
 * so this module cannot manufacture the negative on the field's behalf — it
 * leaves the key off the returned object instead, so `??` reads the old
 * behaviour out of a genuine absence, never out of a default written here.
 * Present-and-not-boolean is rejected like every other field, `null`
 * included — there is no legal `null` reading here the way there is for
 * `final`.
 *
 * @param {unknown} session a parsed `session.json` — or anything at all
 * @returns {{ final: 'independent' | 'self' | null,
 *   evidence: 'host' | 'recorded' | 'inferred' | 'none',
 *   stoppedByOperator: boolean,
 *   unitOnRecord?: boolean } | null}
 */
export function frozenReviewVerdict(session) {
  // The `try` spans the whole body, including the construction of the returned
  // object: a getter can raise on any of the five reads, and narrowing the
  // wrapper to one of them would leave the others able to escape.
  try {
    if (!session || typeof session !== 'object') return null;
    const verdict = /** @type {any} */ (session).reviewVerdict;
    if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict)) return null;
    const { final, evidence, stoppedByOperator, unitOnRecord } = verdict;
    // `null` is a verdict — "there is no final review" — and is not the same as
    // a missing field, which is why membership is tested before nullness.
    if (final !== null && !FINAL.has(final)) return null;
    if (!EVIDENCE.has(evidence)) return null;
    if (typeof stoppedByOperator !== 'boolean') return null;
    // Absent (`undefined`) is the compatibility arm — see header — and is the
    // only non-boolean this field accepts; anything else did not come from a
    // measurement and rejects the whole verdict, same as a bad
    // `stoppedByOperator`.
    if (unitOnRecord !== undefined && typeof unitOnRecord !== 'boolean') return null;
    return unitOnRecord === undefined
      ? { final, evidence, stoppedByOperator }
      : { final, evidence, stoppedByOperator, unitOnRecord };
  } catch {
    // Unreadable is unrecognised. See the header: `null` sends the caller to a
    // live census, which is the only answer that cannot refuse correct work.
    return null;
  }
}
