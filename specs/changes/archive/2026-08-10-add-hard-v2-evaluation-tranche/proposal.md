# Add Hard-v2 Evaluation Tranche

## Why

Hard-v2 currently contains one reviewed bug task. Repeating that task would estimate variance for one concurrency fixture but would not test whether Forgekit behavior generalizes across maintenance categories. The corpus must gain task diversity before more provider budget is spent or any effectiveness claim is considered.

This tranche adds the three most distinct remaining categories—Security, Tests, and Integration—while leaving Feature and Refactor for a later reviewed tranche. Hard-v2 remains explicitly incomplete after this change.

## What Changes

- Add the hard Security task `tenant-signed-downloads`, covering tenant-bound HMAC capabilities, expiry, malformed input, and cross-tenant replay.
- Add the hard Tests task `partial-refund-ledger-invariants`, covering cumulative refund accounting, failure effects, exact boundaries, and idempotency.
- Add the hard Integration task `carrier-event-reconciliation`, covering carrier-specific normalization, scoped deduplication, write order, and non-regressing projections.
- Give every task deterministic hidden verification, a semantic test-quality mutant, untouched and tamper negatives, two independently structured correct implementations, and three isolated Docker contexts.
- Make hard-v2 smoke validation manifest-driven for task-specific mutant files and all selected task contexts.
- Update operator documentation and prepare a reproducible calibration protocol without invoking a provider or presenting calibration as effectiveness evidence.

## Capabilities

- `evaluation-corpus`: expand hard-v2 from one bug task to four independently graded categories while preserving deterministic, solution-independent grading. (delta: `specs/evaluation-corpus/spec.md`)
- `benchmark-harness`: validate every selected hard-v2 task and exactly three build contexts per task without reservation-specific assumptions. (delta: `specs/benchmark-harness/spec.md`)

## Impact

Affected areas are `evals/harbor/tasks/forgekit-hard-v2/`, the hard-v2 manifest, task-specific host evidence, `smoke-hard-v2.mjs`, smoke tests, and evaluation documentation. V1 bytes, defaults, historical results, provider execution, and aggregation semantics do not change. The principal risks are weak hidden oracles, verifier leakage, source-prescriptive grading, duplicated domain failure modes, and falsely labeling a one-repetition pilot as counterbalanced; the design includes explicit evidence against each.
