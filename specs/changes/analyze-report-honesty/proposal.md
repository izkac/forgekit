# Analyze Report Honesty

## Why

`forge analyze` in forgekit reports that no model-policy dispatches were
recorded across dozens of real subagent runs, grades a host `<synthetic>`
pseudo-model, and prints per-model / per-phase tables that quietly describe
whatever single `metrics.json` still sits on disk. The aggregation layer
already knows the two-tier evidence model; the durable digest and the
renderer do not carry it through. Findings F64–F69 (report F-A1…F-A5).

## What Changes

- Dogfood Claude PreToolUse wiring in this repo (hooks + merged settings).
- Split the empty Model-policy line: hook absent vs tables present with zeros.
- Fold compact `byModel` / `byPhase` into the session digest at phase done;
  analyze prefers those splits when `metrics.json` is gone.
- Caption / layout that separates digest-wide columns from detailed-only ones.
- Rename per-model `err` → `sess err`.
- Filter `<synthetic>` at metrics collection so new digests never name it.
- Resolve F64, F65, F66, F67, F68, F69.

## Capabilities

- `session-analysis`: honest analyze report and durable digest splits
  (delta: `specs/session-analysis/spec.md`)

## Impact

- Code: `packages/cli/src/analyze.mjs`, `analyze.test.mjs`, `ledger.mjs`
  (+ ledger tests), `metrics/transcript.mjs` / `collect.mjs` (+ tests),
  repo `.claude/` (init output committed).
- Risk: digest schema grows — old digests without splits stay valid;
  analyze falls back as today when splits absent. Filtering `<synthetic>`
  changes new collections only (historical lines sunk).
- Migration: none required for consumers; optional re-run of
  `forge init --claude` elsewhere for dogfooding.
- Findings: resolve F64–F69. F48 / F13 / F63 / F70–F71 out of scope.
