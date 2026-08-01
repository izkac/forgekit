# Analyze Coverage Honesty

## Why

`forge analyze` reports a single coverage ratio (`N of T carry metrics`). That
blends sessions that never had telemetry with sessions whose collection
failed. A live regression (lost transcript) looks the same as an old session,
and the ratio only drifts up as history ages out — it will never flag the next
failure (F70).

## What Changes

- Split coverage into `measured`, `predatesTelemetry`, and `collectionFailed`
- Keep `sessionsWithMetrics` / `ratio` as aliases of measured / measured÷total
  for JSON consumers
- Lead the rendered report with the three counts, not one blended ratio alone

## Capabilities

- `analyze-report`: honest coverage breakdown (delta: `specs/analyze-report/spec.md`)

## Impact

Analyze output only. No collection or ledger schema change.
