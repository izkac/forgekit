# Delta for findings-ledger

## ADDED Requirements

### Requirement: Related open bugs surface on session create

When `forge new <slug>` creates a session, the system SHALL include open
findings of kind `bug` whose `change` equals the slug or whose `change`/`text`
matches a slug token of length at least 4. The result SHALL appear as
`relatedFindings` on the command's JSON output. Session creation SHALL NOT
fail because related findings exist.

#### Scenario: Matching bug is listed
- GIVEN an open bug with `change: "fix-parser"`
- WHEN `forge new fix-parser` runs
- THEN the JSON includes that finding under `relatedFindings`
- AND the session is created successfully

### Requirement: Stale open bugs appear on status

`forge status` JSON SHALL include `staleFindings`: open bugs whose
`createdAt` is more than 7 days before now, each with `id`, `ageDays`, and
`text`.

#### Scenario: Seven-day-old bug is stale
- GIVEN an open bug with `createdAt` eight days ago
- WHEN `forge status` runs
- THEN `staleFindings` contains that finding with `ageDays` ≥ 7

## MODIFIED Requirements

### Requirement: Finding kind is required and enumerated

(Documentation consumers) Agent-facing docs SHALL instruct that `--kind` and
`--severity` are required on `forge finding add`, and SHALL state the
guardrails: fix beats file; re-check dependents on resolve; never narrow a
heuristic without a measured corpus.
