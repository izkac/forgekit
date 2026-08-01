# Session Analysis Spec

## Purpose

Describe this capability.

## Requirements

### Requirement: Durable per-model and per-phase splits
The system SHALL fold compact per-model and per-phase request/token splits into
the session digest written at phase done (via `compactMetrics`), and
`forge analyze` SHALL use those digest splits when a session’s `metrics.json`
is absent, preferring a live `metrics.json` when present.

#### Scenario: Analyze after cleanup still shows model token split

- GIVEN a digest line whose `metrics.byModel` maps a model to non-zero requests
  and tokens
- AND the session directory (or its `metrics.json`) is gone
- WHEN `buildAnalysis` / `forge analyze` runs
- THEN that model’s row includes those request and token totals from the digest
- AND the row is not forced to zero solely because `metrics.json` is missing

#### Scenario: Live metrics.json wins over digest splits

- GIVEN both a live `metrics.json` with `byModel` and a digest with
  `metrics.byModel`
- WHEN `buildAnalysis` runs
- THEN per-model token and request sums for that session come from the live
  document

### Requirement: Honest model-policy empty states
When formatting analysis, the system SHALL distinguish “no session carried a
dispatch table” from “sessions carried dispatch tables that are all zero”.

#### Scenario: No dispatch tables anywhere

- GIVEN aggregated `dispatches.sessions` is 0
- WHEN `formatAnalysis` renders the Model policy line
- THEN the text advises wiring the PreToolUse hook (forge init)

#### Scenario: Tables present but all zero

- GIVEN aggregated `dispatches.sessions` is greater than 0
- AND aggregated `dispatches.total` is 0
- WHEN `formatAnalysis` renders the Model policy line
- THEN the text reports that those sessions recorded no dispatches
- AND it does not solely advise wiring the hook as if none were measured

### Requirement: Analyze does not grade host synthetic turns as a model
The system SHALL NOT treat the model slug `<synthetic>` as a real model in
metrics collection `byModel` buckets, and `buildAnalysis` SHALL NOT emit a
by-model row for `<synthetic>` even when historical digests still list that
name.

#### Scenario: Collection skips synthetic

- GIVEN a host transcript request whose model is `<synthetic>`
- WHEN metrics are collected / summarised
- THEN `byModel` has no `<synthetic>` key

#### Scenario: Analyze skips synthetic names in digests

- GIVEN a digest whose `metrics.models` includes `<synthetic>`
- WHEN `buildAnalysis` runs
- THEN `byModel` has no `<synthetic>` key

### Requirement: By-model table labels match evidence tiers
`formatAnalysis` SHALL label the per-model error column so it is not read as a
per-model tool-error rate, and SHALL caption which columns are digest-wide
versus detailed-split-only (including requests, not only tokens).

#### Scenario: sess err header

- GIVEN an analysis with at least one by-model row
- WHEN `formatAnalysis` renders the By model table
- THEN the error column header is `sess err` (not bare `err`)

#### Scenario: Caption covers requests

- GIVEN an analysis with at least one by-model row
- WHEN `formatAnalysis` renders the By model section
- THEN the caption indicates that request and token columns cover only
  sessions with a detailed split (not only “tokens”)

### Requirement: Forgekit dogsfoods Claude model-policy hooks
The forgekit repository SHALL ship committed Claude Code hook files and
settings that register PreToolUse for Agent/Task to
`.claude/hooks/forge-model-hook.mjs`, so local Claude Code runs can record
dispatches.

#### Scenario: Hook path present in tree

- GIVEN a clean checkout of forgekit
- WHEN an operator inspects `.claude/hooks/forge-model-hook.mjs` and
  `.claude/settings.json`
- THEN the hook file exists and settings register PreToolUse with that command
