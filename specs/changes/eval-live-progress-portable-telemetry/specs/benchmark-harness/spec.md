# Benchmark Harness Delta

## ADDED Requirements

### Requirement: Long-running trials expose sanitized progress

The evaluator SHALL emit run and trial lifecycle messages plus periodic heartbeats on stderr without changing the single JSON plan emitted on stdout. Heartbeats SHALL be configurable with a validated non-negative interval, SHALL default to 30 seconds, and SHALL contain no credentials, task instructions, source paths, checkout paths, or treatment source paths.

#### Scenario: Healthy model execution remains observable
- **WHEN** a Harbor trial runs longer than the configured progress interval
- **THEN** stderr identifies the run id, trial id, arm, running status, and elapsed time at least once before terminal completion
- **AND** stdout remains exactly one parseable plan document

### Requirement: Forge artifact telemetry is portable

The evaluator SHALL represent the discovered Forge artifact directory with a locator relative to the trial output root. Structured summaries, normalized results, manifests, and plans SHALL NOT contain the absolute checkout, run root, source tarball path, or absolute artifact discovery path.

#### Scenario: Forge artifacts are normalized
- **WHEN** a Forge trial produces `.forge` artifacts
- **THEN** normalized instrumentation contains `artifactLocator` and its relative file inventory
- **AND** it does not contain `artifactPath` or any host-absolute run path
