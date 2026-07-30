# A dispatch with no substance stops grading as host evidence of a review

## Why

`hostFinalReview` in `packages/cli/src/review-census.mjs` grades a review unit
`independent` on `host` evidence whenever the host recorded a dispatch that was
not stopped. It never asks whether the subagent did anything.

`set-phase.mjs:324` passes the money/auth final-review floor on
`verdict.final === 'independent'` alone, whatever the evidence grade. So a
throwaway subagent dispatched as `forge-review final <sessionId>` — 1 request,
15 tokens, reviewing nothing — passes the gate against a review file that states
plainly that no subagent read the change. An independent reviewer reproduced
this; it is finding **F33**. Docs and CHANGELOG claimed the record "cannot be
fabricated without really dispatching a subagent", which is true and beside the
point: dispatching a subagent is cheap.

The mitigation was planned in F20 — "request counts that distinguish a real
review from a token one" — and `units[*].requests` has been collected, windowed
and persisted by `metrics/review-evidence.mjs` ever since, read by nobody.

Second, `packages/cli/src/review-verdict.mjs` has no test file (**F34**). It is
87 lines of strict validation sitting in front of that same gate, the scorecard's
29-point cap and the durable `sessions.jsonl` digest, covered only incidentally
through `ledger.test.mjs` and `set-phase.test.mjs`. Every other module in the
cluster has its own.

## What Changes

- `reviewEvidence` adds `maxRequests` to each unit bucket: the busiest single
  dispatch for that unit **among those the operator did not stop**. `requests`
  (the sum) is unchanged and still persisted.
- `hostFinalReview` applies a request floor of **5** on the branch that would
  return `independent`. Below it, the function returns `null` — the answer it
  already uses for "the host cannot answer" — and the census falls back to the
  review file's prose, grading `inferred`.
- `review-verdict.test.mjs` is added. `review-verdict.mjs` itself does not
  change.

No new verdict value, no new evidence grade, no change to the money/auth gate's
`final === 'independent'` test, no change to the frozen-verdict shape.

## Capabilities

- `review-evidence`: a dispatch must carry substance before it can certify a
  review — delta at `specs/review-evidence/spec.md`

## Impact

**Affected code**

- `packages/cli/src/metrics/review-evidence.mjs` — `maxRequests` on the bucket
- `packages/cli/src/review-census.mjs` — the floor, in `hostFinalReview`
- `packages/cli/src/review-verdict.test.mjs` — new
- `packages/cli/src/metrics/review-evidence.test.mjs`,
  `packages/cli/src/review-census.test.mjs` — new cases

**Risk: the floor fires on real work.** Measured with the product's own
`readReviewerSidecars` across all 24 `forge-review` dispatches on this machine
(2026-07-30): minimum 15 requests, median 55, maximum 173, none below 15. The
floor of 5 sits 3x under the observed minimum and 5x over the forgery. F11
records what happens when a threshold ships without a corpus behind it; this one
has one, and `decisions.md` says to re-measure before moving it.

**Risk: a real reviewer degrades to prose.** A record whose transcript was
pruned keeps `requests: 0` by design (`review-evidence.mjs:220`), so it reads as
sub-floor. The cost is usually a weaker evidence grade — but not *never* a
refusal: a verdict graded `inferred` is unprotected by the freeze, so a
below-floor session whose sidecar is later pruned can be refused at the gate.
See `design.md`'s Risks section, which carries the reproduction. Prose still
loses only a grade where the freeze does not intervene, and 0 of 420 sidecar
metas on this machine lack a transcript, so the case is rare either way.

**Not fixed here**, and staying filed: F27 (a partially readable host binding
still yields a confident wrong positive — owner is `host.mjs`), F11/F18/F19 (the
prose rules, whose stakes this change raises by making prose more reachable),
F12 (stamping the review file at dispatch time, which this does not substitute
for or block).

**Migration**: none. Verdicts already frozen onto finished sessions are not
re-judged, which is what freezing is for.
