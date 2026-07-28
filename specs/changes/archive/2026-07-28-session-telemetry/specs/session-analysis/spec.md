# Spec: session analysis

## Purpose

The durable ledgers are only useful if they can be read back as numbers. Forge
must be able to answer, deterministically, how the workflow and the models are
performing across sessions — and must be honest about how much of that history
it can actually see.

## Requirements

### Requirement: Analysis is deterministic and read-only

`forge analyze` SHALL compute its aggregates solely from `sessions.jsonl`,
`scorecards.jsonl` and any on-disk `metrics.json`, print to stdout, and write no
files. Narrative reporting remains the job of the `/forge:analyze` command,
which consumes this output.

#### Scenario: Analysis run twice

- **GIVEN** unchanged ledgers
- **WHEN** `forge analyze --json` runs twice
- **THEN** both runs emit the same object
- **AND** no file under `.forge/` is created or modified

### Requirement: Coverage is stated before any aggregate

Output SHALL lead with how many of the analysed sessions carry metrics, so a
partial history is never mistaken for a complete one.

#### Scenario: Mixed history

- **GIVEN** nine sessions in the ledger of which six have metrics
- **WHEN** `forge analyze` runs
- **THEN** the output states that six of nine sessions have metrics
- **AND** token aggregates are computed only over those six

### Requirement: Per-model quality is reportable

Analysis SHALL group work by resolved model, reporting request and token counts,
tool error rate, and the grades of the sessions each model ran in, so model
performance can be compared on evidence rather than impression.

#### Scenario: Two models across a history

- **GIVEN** sessions in which two different models ran
- **WHEN** `forge analyze` runs
- **THEN** each model has its own row with requests, tokens, error rate and the
  session grades it participated in

### Requirement: Enforcement skip rate is reportable

Analysis SHALL report dispatch totals — allowed, rewritten, denied and skipped —
across the analysed sessions, so the frequency of bypassing `forge
resolve-model` is measurable.

#### Scenario: Coordinator skipping the resolver

- **GIVEN** sessions whose dispatch ledgers contain rewritten and denied entries
- **WHEN** `forge analyze` runs
- **THEN** the output reports the skipped count and its share of total dispatches

### Requirement: Empty and partial histories are handled

Analysis SHALL succeed with an explicit "nothing to analyse" result when the
ledgers are empty, and SHALL exclude metric-less sessions from token math while
still counting them in coverage.

#### Scenario: Fresh project

- **GIVEN** no `sessions.jsonl` and no `scorecards.jsonl`
- **WHEN** `forge analyze` runs
- **THEN** it exits successfully stating there is nothing to analyse yet
