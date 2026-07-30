# Design

## Context

`metrics/review-evidence.mjs` measures what the host recorded about subagent
dispatches. `review-census.mjs` turns that into a verdict. `review-verdict.mjs`
validates the verdict once it has been frozen onto `session.json`. The money/auth
floor in `set-phase.mjs` reads the frozen verdict and refuses when the final
review is missing or self-authored.

The chain is sound except at one step: the census asks *whether* a dispatch
happened and never *what it did*. `bucket.requests` has been sitting on the
evidence object since it was introduced, unread.

## Decisions

- **Decision: a sub-floor dispatch makes `hostFinalReview` return `null`, which
  routes the verdict to the review file's prose (`inferred`).**
  - Alternatives considered: grade it `self` and refuse at the gate; keep
    `independent` but weaken the evidence grade.
  - Rationale: refusing is the shape reverted twice already (0.3.24, 0.3.25),
    and a genuine reviewer whose transcript was pruned reads as 0 requests — so
    refusing on a low count refuses correct work. Prose is the side of this call
    that can only lose a grade. Weakening the grade alone changes nothing,
    because the gate tests `final === 'independent'` and ignores the grade;
    making the grade matter means tightening the gate, which is a larger change
    with its own revert history.
  - This closes F33's reproduction: the forged session's review file states no
    subagent read the change, so prose grades it `self` and the gate refuses.

- **Decision: the floor is 5 requests, and it lives in `review-census.mjs`.**
  - Alternatives considered: 2; 10; configurable via `.forge/config.json`.
  - Rationale: measured with the product's own `readReviewerSidecars` over all
    24 `forge-review` dispatches on this machine (2026-07-30) — min 15, median
    55, max 173, none below 15; the forgery was 1. Five is 3x under the observed
    minimum and 5x over the forgery. Two closes the reproduction and little else
    (pad to 3 and walk through). Ten is only a third under the minimum, close
    enough that a short review of a small change would start degrading.
    Configurable was rejected because a threshold an operator can lower is one a
    forger can lower — the config file lives in the repo being reviewed.
  - The constant goes in the census because the collector *measures* and the
    census *judges*; a floor is policy.

- **Decision: the bucket gains `maxRequests`, computed over unstopped records
  only.**
  - Alternatives considered: apply the floor to `bucket.requests`, the existing
    sum.
  - Rationale: a sum answers the wrong question. Ten forged dispatches at one
    request each sum to 10 and clear a floor of 5, and the question the floor
    asks is whether *any single* dispatch looks like a real review. Restricting
    to unstopped records closes the paired case: one long dispatch the operator
    stopped (60 requests) beside one forged dispatch (1) yields
    `stopped(1) < dispatched(2)` → `independent`, and an unrestricted
    `maxRequests` of 60 would vouch for the forgery. `requests` stays on the
    bucket — it is persisted evidence and other readers may want the total.

- **Decision: `requests: 0` stays ambiguous.**
  - Alternatives considered: distinguish "could not measure" from "measured
    zero", and let the unmeasurable case keep `host` grade.
  - Rationale: deleting a transcript is easier than faking one, so that
    distinction would be an escape hatch rather than a fix. Under the decision
    above both cases route to prose, so the ambiguity costs a grade and never a
    refusal.

- **Decision: `review-verdict.mjs` gets a test file; its behaviour does not
  change.**
  - Alternatives considered: move the floor into `review-verdict.mjs`.
  - Rationale: it validates the *frozen shape* and knows nothing about units or
    dispatches — deliberately, per its own header. The floor belongs where the
    bucket is read.

## Risks / Trade-offs

- **The floor fires on real work.** Mitigated by the corpus above and by the
  direction of failure: a false positive costs an evidence grade, not a
  transition. `decisions.md` records that the floor must be re-measured against
  a real corpus before it is moved — the rule F11 was filed to establish.
- **Prose becomes more reachable.** Every sub-floor dispatch now lands on the
  prose rules, which F11, F18 and F19 all say are imperfect. This is a
  deliberate trade: the prose path can misgrade, the host path was certifying
  forgeries. F12's structural fix (stamp the review file at dispatch time)
  remains the real answer and is untouched by this change.
- **An attacker who reads this spec can pad to 5 requests.** True, and the floor
  is not claimed to be a security boundary — it removes the one-line forgery,
  raising the cost from a single throwaway dispatch to a subagent that must
  genuinely run. Closing it properly is F12.
