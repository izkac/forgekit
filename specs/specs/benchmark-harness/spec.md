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

### Requirement: Versioned multi-category corpus
The evaluator SHALL catalog canonical tasks covering bug, feature, integration, refactor, tests, and security categories. Each task SHALL keep hidden checks in a separate verifier and SHALL pass local untouched, known-good, and visible-test-tamper oracle validation.

#### Scenario: Corpus contract is validated
- **WHEN** evaluator tests inspect the corpus
- **THEN** each required category maps to one safe canonical task id
- **AND** every task has complete Harbor metadata, agent fixture, separate verifier, solution oracle, and immutable visible regression test

### Requirement: Reproducible counterbalanced arm schedule
For paired runs the evaluator SHALL record a seed, choose the starting arm deterministically from that seed and task revision, and alternate arm order by repetition.

#### Scenario: Seeded schedule is replayable
- **WHEN** the same task, seed, arms, and repetition count are planned twice
- **THEN** both plans contain the same arm schedule
- AND even repetition counts schedule each arm first equally often
- AND every manifest records its exact schedule position

### Requirement: Honest paired aggregation
The evaluator SHALL aggregate only coherent provenance cohorts, SHALL reject duplicate cells, SHALL expose incomplete pairs and missing instrumentation, and SHALL compute paired deltas only from complete task/repetition pairs.

#### Scenario: Complete and incomplete results are distinguished
- **WHEN** normalized results contain complete and missing arm pairs
- **THEN** arm/task/category summaries include all valid observations
- AND paired summaries use only complete pairs
- AND the output reports excluded pairs and missing values
- AND it makes no automatic effectiveness claim

#### Scenario: Mixed provenance fails closed
- **WHEN** requested run directories differ in agent, model, Forgekit treatment, or harness revision
- **THEN** aggregation exits non-zero without emitting a comparison

### Requirement: Long-running trials expose sanitized progress
The evaluator SHALL emit run and trial lifecycle messages plus periodic heartbeats on stderr without changing the single JSON plan emitted on stdout. Heartbeats SHALL be configurable with a validated interval from 0 through 86400 seconds, SHALL default to 30 seconds, and SHALL contain no credentials, task instructions, source paths, checkout paths, or treatment source paths.

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

### Requirement: Evaluation corpora are explicitly versioned and allowlisted
The evaluator SHALL select corpora only through checked-in ID-to-root mappings. Omitting corpus selection SHALL retain `forgekit-held-out-v1`; filesystem paths and unknown IDs SHALL fail before execution.

#### Scenario: Operator selects the hard companion corpus
- **WHEN** the runner receives `--corpus forgekit-hard-v2`
- **THEN** it stages tasks only from that corpus's checked-in root
- **AND** plans and manifests bind its ID, manifest revision, task revision, and task version

#### Scenario: Operator omits corpus selection
- **WHEN** the runner receives no corpus selector
- **THEN** selection and staging remain `forgekit-held-out-v1`

### Requirement: Published v1 bytes are immutable
CI SHALL compare the v1 manifest and each v1 task tree to a checked-in revision lock. A mismatch SHALL fail and require a new corpus ID rather than silently rewriting v1.

### Requirement: Hard-v2 smoke validates every allowlisted task
The isolated hard-v2 smoke SHALL validate every manifest-selected task's metadata, baseline and Forge staging, verifier isolation, task-specific host evidence, semantic-mutant evidence, and three Docker build contexts without invoking Harbor or a model.

#### Scenario: Four-task tranche is selected
- **GIVEN** hard-v2 contains bug, security, tests, and integration entries
- **WHEN** the operator runs `npm run smoke:evals:hard-v2`
- **THEN** all four task-specific host suites pass
- **AND** the machine-readable report contains all four categories
- **AND** Docker validation checks exactly twelve contexts: baseline agent, Forge agent, and separate verifier for each task

#### Scenario: Selected task lacks semantic-mutant evidence
- **WHEN** a hard-v2 manifest entry has no task-local complete semantic mutant required by its verifier
- **THEN** smoke fails before reporting the corpus as valid

### Requirement: Calibration order claims match the schedule
Operator guidance SHALL call one baseline/Forge repetition a paired calibration with disclosed first-position imbalance. It SHALL reserve the term counterbalanced for an even repetition count, which balances first position exactly within a task.

#### Scenario: Operator budgets one repetition
- **WHEN** calibration uses `--arm both --repetitions 1 --concurrency 1`
- **THEN** guidance describes the result as one paired calibration
- **AND** directs the operator to retain the recorded starting arm and imbalance

#### Scenario: Operator requires exact within-task order balance
- **WHEN** the operator requires each arm to run first equally often for a task
- **THEN** guidance uses an even repetition count, beginning with two
