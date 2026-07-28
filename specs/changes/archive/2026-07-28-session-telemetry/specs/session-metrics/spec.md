# Spec: session metrics

## Purpose

A Forge session must leave behind a factual record of how it ran — tokens,
models, tool failures, subagents, dispatch decisions — harvested from what the
host agent already wrote, and durable beyond the deletion of the session
directory.

## Requirements

### Requirement: Sessions bind to their host without hook wiring

Forge SHALL record the host agent and its session identifier on `session.json`
from the process environment, at session creation and on later commands, so that
binding does not depend on any hook being installed or on the Forge session
existing when the host session started.

#### Scenario: Session created mid-conversation

- **GIVEN** a host session already running with `CLAUDE_CODE_SESSION_ID` set
- **WHEN** `forge new <slug>` runs
- **THEN** `session.json` records `host.agent: "claude-code"` and that id in
  `host.sessionIds`

#### Scenario: Session resumed under a new host session

- **GIVEN** a session bound to host id `A`
- **AND** a later `forge phase` command runs under host id `B`
- **WHEN** the session is saved
- **THEN** `host.sessionIds` contains both `A` and `B`, without duplicates

#### Scenario: No host environment

- **GIVEN** no `CLAUDE_CODE_SESSION_ID` in the environment
- **WHEN** a Forge command runs
- **THEN** `host.agent` is `"unknown"`, no ids are recorded, and the command
  succeeds normally

### Requirement: Usage is counted once per request

The collector SHALL collapse assistant transcript lines to one entry per
`requestId` before summing usage, because the host writes one line per content
block and repeats the same `usage` object on each.

#### Scenario: One request, several content blocks

- **GIVEN** a transcript containing 39 assistant lines across 12 distinct
  `requestId` values
- **WHEN** metrics are collected
- **THEN** `requests` is 12
- **AND** token totals equal the sum over the 12 distinct requests, not the 39
  lines

### Requirement: Only the session's own work is attributed

The collector SHALL restrict attribution to lines whose timestamp falls within
`[session.createdAt, collectedAt]` on the bound transcripts, because one host
session commonly spans several sequential Forge sessions.

#### Scenario: Two Forge sessions in one host session

- **GIVEN** a host transcript covering Forge session `X` followed by session `Y`
- **WHEN** metrics are collected for `Y`
- **THEN** only requests timestamped after `Y.createdAt` are counted

### Requirement: Metrics record counts, never content

Persisted metrics SHALL contain only counts, model slugs, tool names, agent
types, phase names and timestamps. Prompt text, model responses, command
strings, file contents, and the subagent `description` field SHALL NOT be
written.

#### Scenario: Subagent harvested

- **GIVEN** a subagent sidecar whose `meta.json` carries a free-form
  `description`
- **WHEN** metrics are collected
- **THEN** the subagent record contains `agentType`, models, request and token
  counts
- **AND** contains no `description` field

### Requirement: Dispatch decisions are recorded

When a Forge session is active, `forge enforce-model` SHALL append one line per
subagent dispatch recording the requested model, the resolved model, and whether
the dispatch was allowed, rewritten or denied — including when
`models.local.json` is absent, since the skip rate is the measurement of
interest before enforcement is enabled.

#### Scenario: Coordinator dispatches an unresolved model

- **GIVEN** an active Forge session
- **WHEN** a dispatch is rewritten or denied by the model policy
- **THEN** a line is appended to `dispatches.jsonl` naming both models and the
  decision
- **AND** the collected metrics report it under `dispatches.skipped`

#### Scenario: No active session

- **GIVEN** no active Forge session
- **WHEN** a dispatch is evaluated
- **THEN** nothing is logged and the decision is unchanged

### Requirement: Telemetry is advisory and cannot block work

Collection, dispatch logging and digest enrichment SHALL NOT throw, alter a hook
decision, or prevent a phase transition. Any failure SHALL be recorded as
`available: false` with a human-readable reason.

#### Scenario: Transcript missing or pruned

- **GIVEN** a session whose host transcript no longer exists
- **WHEN** `forge phase done` runs
- **THEN** `metrics.json` records `available: false` with a reason
- **AND** the phase transition and scorecard complete normally

#### Scenario: Dispatch log write fails

- **GIVEN** an unwritable session directory
- **WHEN** a dispatch is evaluated
- **THEN** the hook's decision output is byte-identical to the unlogged case

### Requirement: Metrics survive session cleanup

A compact metrics summary SHALL be written into the `sessions.jsonl` digest
before the session directory becomes eligible for deletion, so history remains
after `forge cleanup`.

#### Scenario: Session finished then pruned

- **GIVEN** a session that reached `done` with metrics collected
- **WHEN** `forge cleanup` deletes its directory
- **THEN** its `sessions.jsonl` line still reports request, token, error and
  dispatch totals
