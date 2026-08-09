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
The evaluator SHALL stage one canonical task into a baseline arm and a Forge arm without changing the task's starting repository. Only the Forge arm may install Forgekit or receive Forge workflow instructions. Forgekit MAY come from either a selected published version or a provenance-bound local tarball.

#### Scenario: Baseline and Forge staging differ only by treatment

- GIVEN a valid canonical task and exactly one Forgekit treatment selector
- WHEN the runner stages both arms
- THEN both staged tasks contain identical fixture files and verifier files
- AND the baseline has no Forgekit installation or package archive
- AND the Forge arm installs exactly the selected treatment
- AND each instruction identifies its arm

### Requirement: Safe Harbor invocation
The runner SHALL validate model, agent, arm, repeat, concurrency, and Forgekit
treatment inputs before invoking Harbor. It SHALL invoke Harbor with an argv
array rather than a shell command string and SHALL write a manifest for each
trial.

#### Scenario: Dry-run is deterministic

- GIVEN valid runner options and `--dry-run`
- WHEN the runner is executed
- THEN it emits the staged arm plan and Harbor argv without invoking Harbor
- AND it exits successfully without requiring Harbor or model credentials

#### Scenario: Invalid input is rejected

- GIVEN an unsupported arm, non-positive repeat/concurrency, unsafe package
  version, or invalid local-tarball selector
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

### Requirement: Provenance-bound local Forgekit treatment
The evaluator SHALL accept an explicitly selected local Forgekit tarball as an alternative to a published semantic version. It SHALL snapshot the file bytes, identify that exact archive by SHA-256, stage it only in the Forge arm, verify the digest before installation, and record treatment provenance in the run plan and every trial manifest.

#### Scenario: Local tarball is installed only in the Forge arm

- GIVEN a readable regular-file Forgekit tarball
- WHEN the runner stages both arms with the local-tarball selector
- THEN the baseline contains neither Forgekit instructions nor the local archive
- AND the Forge Docker context contains a runner-named digest-bound archive
- AND the Forge Dockerfile verifies the recorded digest before installing that archive
- AND the canonical task and verifier remain unchanged

#### Scenario: Local treatment is attributable without leaking host paths

- GIVEN a local tarball produced from a checkout that may contain uncommitted changes
- WHEN the runner emits a plan and trial manifests
- THEN each record identifies the treatment as `local-tarball`
- AND records the archive SHA-256, byte size, and staged filename
- AND does not record the operator's absolute source path
- AND does not label the local payload as a published Forgekit version

#### Scenario: Treatment selection fails closed

- GIVEN both or neither of `--forgekit-version` and `--forgekit-tarball`, an unreadable path, or a path that is not a regular file
- WHEN the runner validates the request
- THEN it rejects the request before invoking Harbor or creating a trial
