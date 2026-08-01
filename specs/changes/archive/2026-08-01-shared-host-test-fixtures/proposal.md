# Shared Host Test Fixtures

## Why

Host-tree planting helpers are duplicated across `review-evidence.test.mjs`,
`collect.test.mjs`, and `review-census.test.mjs` (F55). The fixtures decide
money/auth-adjacent evidence paths; three copies drift independently.

## What Changes

- Add `packages/cli/src/metrics/test-host-tree.mjs` with shared helpers
- Rewire the three test files to import them
- No production behaviour change

## Capabilities

- `session-metrics`: shared test host tree (delta)

## Impact

Test-only. Resolve F55.
