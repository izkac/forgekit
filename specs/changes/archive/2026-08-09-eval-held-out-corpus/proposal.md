# Change: add a multi-category held-out evaluation corpus

## Why

The single health-endpoint task proves Harbor wiring but cannot support a claim about Forge's effect across coding work. Trial order is fixed and results require manual comparison, leaving order bias and selective aggregation risks.

## What Changes

- Define a versioned corpus manifest covering bugs, features, integrations, refactors, tests, and security with separate hidden verifiers.
- Add five dependency-free Node tasks alongside the existing feature task, each with untouched, known-good, and test-tamper validation.
- Seed and record randomized, counterbalanced baseline/Forge scheduling.
- Add fail-closed cohort validation and paired aggregation by task/category with explicit missingness and no automatic effectiveness claim.
- Document local-tarball corpus dry runs and conservative interpretation; do not publish Forgekit.

## Capabilities

- `benchmark-harness`: multi-category corpus, reproducible arm scheduling, and paired aggregation.
