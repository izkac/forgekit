# Design

## Context

`freezeReviewVerdict` measures who wrote the final review once, at the
`finish`/`done` transition, and freezes the answer so it survives the host
pruning its transcript. `enforceFinalReviewFloor` then reads that verdict and
refuses a high-risk change whose final review is missing or self-authored.

The freeze has an escape hatch for the case where a *second* pass reads worse
evidence than the first: keep the earlier verdict when this pass learnt nothing
about the final review. That hatch is gated on the earlier verdict having been
`host`-graded, which is not the same question.

## Decisions

- **Decision: persist `sawTheUnit` onto the verdict as `unitOnRecord`, and read
  it in the keep rule.**
  - Alternatives considered: drop the `evidence === 'host'` conjunct; test
    `next.evidence === 'host'` instead; widen to
    `frozen.evidence === 'host' || next.evidence === 'host'`.
  - Rationale: `seen === 0` cannot be resolved in a single pass — "the record was
    pruned" and "nothing was ever dispatched" are byte-identical readings. The
    information that separates them exists only across two passes, and nothing
    carried it from the first to the second. Every rejected alternative infers
    the answer from something correlated with it; this records it.
  - The first alternative breaks a correct pin (a stale prose verdict must not
    outrank a fresher reading of the same durable file). The third was measured
    to pass the whole suite and still suppresses a genuine "nothing was
    dispatched" negative, on the strength of the very reading being distrusted.
    Both are the shape of rule this module has now been reverted for twice.

- **Decision: `unitOnRecord` is optional and boolean-if-present.**
  - Alternatives considered: required; defaulted to `false` when absent.
  - Rationale: `frozenReviewVerdict` rejects anything that is not exactly the
    shape `set-phase.mjs` writes, so a required field would invalidate every
    verdict frozen before this change — all of them falling back to a live
    census, which is precisely the loss the freeze exists to prevent. Defaulting
    absent to `false` is worse than leaving it absent: it would silently assert
    that no dispatch was on record for sessions where one may well have been,
    which is the absence-into-a-negative collapse this change is about. Absent
    means "written before this field existed" and takes the compatibility arm.

- **Decision: the keep rule is one expression, `frozen.unitOnRecord ??
  frozen.evidence === 'host'`.**
  - Alternatives considered: branch on the field's presence.
  - Rationale: the two tests agree wherever both apply. `final === 'independent'`
    on `host` grade is only reachable from a present bucket, so a host-graded
    independent verdict always had the unit on record. The new field subsumes the
    old test rather than contradicting it, which is what makes a fallback safe
    rather than a second policy.

## Risks / Trade-offs

- **Indistinguishable from the rejected option without one test.** If the
  discriminator — a frozen `independent`/`inferred` whose unit was never on
  record must still refresh and refuse — is missing or weak, then "protect every
  frozen independent" passes the suite too, and the weaker rule ships looking
  like this one. That test is the first task of group 2 and is the reason the
  group is ordered that way.
- **A fourth field on a shape three consumers read.** `score.mjs`, `ledger.mjs`
  and the gate all read the verdict through `frozenReviewVerdict`. None of them
  needs `unitOnRecord`, and none should start reading it — it answers a question
  only the freeze asks. Its `@returns` shape widens; nothing else should.
- **The fixture sweep.** Every `deepEqual` against a three-field `reviewVerdict`
  across four test files goes red. 0.3.34's lesson applies unchanged: a fixture
  adjusted until the suite passes is a fixture that stopped testing. Each one
  must be given the value its own scenario would actually produce, and shown to
  still fail when the rule it pins is broken.
- **This does not close the ambiguity, only routes around it.** `seen === 0` is
  still unresolvable in a single pass, so a *first* pass that reads a pruned
  record still grades `self`/`host` and still refuses — there is no earlier
  verdict to compare against. That case is out of scope here and belongs with
  F12, which removes the reliance on transcript survival altogether.
