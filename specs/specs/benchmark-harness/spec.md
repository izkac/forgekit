# Benchmark Harness Spec

## Purpose

Define the developer-only Harbor benchmark contract for comparing the same coding agent and model with and without Forgekit, using an independent verifier as the source of functional outcomes.

## Requirements

### Requirement: Canonical Harbor task contract
The evaluator SHALL keep each benchmark task in Harbor's task format with an
instruction, task metadata, an agent environment, and a verifier. A task that
measures tamper-sensitive outcomes SHALL use a separate verifier environment
and SHALL NOT copy hidden grader sources into the agent environment.

#### Scenario: Smoke task has an external verifier

- GIVEN the `node-health-endpoint` task is staged
- WHEN its verifier is configured
- THEN the agent image contains only the fixture and visible task context
- AND the verifier image contains the hidden grader and emits numeric reward
  metrics

### Requirement: Paired evaluation arms
The evaluator SHALL stage one canonical task into a baseline arm and a Forge
arm without changing the task's starting repository. Only the Forge arm may
install Forgekit or receive Forge workflow instructions.

#### Scenario: Baseline and Forge staging differ only by treatment

- GIVEN a valid canonical task and a selected Forgekit version
- WHEN the runner stages both arms
- THEN both staged tasks contain identical fixture files and verifier files
- AND the baseline Dockerfile has no Forgekit installation
- AND the Forge Dockerfile installs the selected Forgekit package
- AND each instruction identifies its arm

### Requirement: Safe Harbor invocation
The runner SHALL validate model, agent, arm, repeat, concurrency, and Forgekit
version inputs before invoking Harbor. It SHALL invoke Harbor with an argv
array rather than a shell command string and SHALL write a manifest for each
trial.

#### Scenario: Dry-run is deterministic

- GIVEN valid runner options and `--dry-run`
- WHEN the runner is executed
- THEN it emits the staged arm plan and Harbor argv without invoking Harbor
- AND it exits successfully without requiring Harbor or model credentials

#### Scenario: Invalid input is rejected

- GIVEN an unsupported arm, non-positive repeat/concurrency, or unsafe package
  version
- WHEN the runner parses the options
- THEN it exits non-zero with a specific validation message
- AND it does not create or execute a trial

### Requirement: Independent result normalization
The evaluator SHALL normalize Harbor reward metrics and optional Forge
instrumentation into a versioned result record. Functional outcome metrics SHALL
come from the external verifier; Forge scorecards SHALL remain secondary
instrumentation.

#### Scenario: Missing Forge telemetry is explicit

- GIVEN a valid Harbor reward JSON without `.forge` artifacts
- WHEN normalization runs
- THEN the output preserves the verifier metrics
- AND instrumentation availability is `false` with a reason
- AND normalization does not downgrade the task outcome

#### Scenario: Shippable outcome is conservative

- GIVEN numeric functional, regression, and quality metrics
- WHEN the result is normalized
- THEN `shippable` is `1` only when all required outcome metrics pass
- AND a missing required metric is not silently treated as a pass
