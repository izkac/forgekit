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

### Requirement: Campaign corpora declare ordered episodes
A corpus manifest MAY declare a campaign: an ordered list of episodes over one
task root, each with its own episode id, instruction and verifier. The runner
SHALL reject a campaign whose episode ids are not unique, whose declared order
is not a contiguous sequence starting at one, or whose episode directories do
not all exist under the selected task root.

#### Scenario: Well-formed campaign manifest is accepted

- **GIVEN** a corpus manifest declaring six episodes in contiguous order
- **WHEN** the runner selects that corpus
- **THEN** it resolves every episode directory under the mapped task root
- **AND** it records the campaign id, episode ids and episode order in the plan

#### Scenario: Malformed campaign manifest is rejected

- **GIVEN** a corpus manifest whose episodes repeat an id or skip an index
- **WHEN** the runner selects that corpus
- **THEN** it exits nonzero with a message naming the offending episode
- **AND** it stages nothing and invokes neither Harbor nor a model

### Requirement: Episodes execute in order with a fresh agent each time
For each arm, the runner SHALL execute a campaign's episodes in declared order,
one trial per episode, each in a fresh agent container with no transcript,
summary or memory carried from the previous episode. The runner SHALL NOT start
episode N+1 for an arm until episode N for that arm has reached a terminal
state.

#### Scenario: Each episode is a separate trial

- **GIVEN** a six-episode campaign and `--arm both`
- **WHEN** one repetition completes
- **THEN** twelve trials are recorded, six per arm, each with its own manifest
- **AND** each trial records its episode id and episode index

#### Scenario: A failed episode stops that arm's campaign

- **GIVEN** an arm whose episode 3 fails operationally
- **WHEN** the runner reaches episode 4 for that arm
- **THEN** it records episodes 4 through 6 as not attempted
- **AND** the other arm's campaign continues
- **AND** the run exits nonzero after persisting all failures

### Requirement: Repository state carries between episodes within an arm
The runner SHALL stage episode N+1's agent environment from episode N's
resulting `/app` contents for the same arm and repetition. Verifier
directories SHALL NOT be carried, mounted into any agent container, or
inherited between episodes. The two arms SHALL NOT share carried state.

#### Scenario: Agent inherits the previous episode's repository

- **GIVEN** episode 1 of the Forge arm wrote `src/orders.mjs` and `.forge/`
- **WHEN** episode 2 of the Forge arm is staged
- **THEN** its agent environment contains both
- **AND** it contains no verifier sources from any episode

#### Scenario: Arms never share carried state

- **GIVEN** both arms completed episode 1 of the same repetition
- **WHEN** episode 2 is staged for each arm
- **THEN** each arm's environment derives only from its own episode 1 output

### Requirement: Carryover is verified, never assumed
Each episode after the first SHALL assert, before grading, that the state it
was supposed to inherit is present. A failed carryover assertion SHALL be
recorded as an operational failure with no verified outcome, and SHALL NOT be
normalized into a zero score.

#### Scenario: Missing inherited state is an operational failure

- **GIVEN** episode 3 is staged without episode 2's output
- **WHEN** its verifier runs
- **THEN** it reports a carryover failure and emits no outcome reward
- **AND** the pair is listed under `incomplete_pairs` by the aggregator
- **AND** no arm is credited with a zero for that episode

### Requirement: Rewards carry requirement and regression counts
An episode verifier SHALL emit `requirements_met` and `requirements_total` for
that episode's own requirements, and `regression_met` and `regression_total`
over every earlier episode's checks. Counts SHALL be non-negative integers with
`met` never exceeding `total`. The existing binary metrics SHALL retain their
current meanings, with `shippable` still requiring every required binary
outcome to pass.

#### Scenario: Counted reward is normalized

- **GIVEN** an episode reward with 7 of 10 requirements and 12 of 14 regression
  checks met
- **WHEN** the normalizer reads it
- **THEN** the normalized result records both ratios and the binary outcomes
- **AND** `shippable` is unchanged in meaning from the existing corpora

#### Scenario: Incoherent counts are rejected

- **GIVEN** a reward whose `requirements_met` exceeds `requirements_total`, or
  whose counts are negative or non-integer
- **WHEN** the normalizer reads it
- **THEN** it exits nonzero and writes no normalized result

#### Scenario: Existing single-shot rewards stay readable

- **GIVEN** a reward from `forgekit-hard-v2` carrying only the binary metrics
- **WHEN** the normalizer reads it
- **THEN** it normalizes successfully with counts recorded as absent
- **AND** absent counts are missing, never zero

### Requirement: False completion is derived mechanically
An episode verifier SHALL emit `false_completion` as 1 when the trial ended
normally, `requirements_met` is below `requirements_total`, and the agent wrote
no blocker file at the repository root; otherwise 0. The determination SHALL
NOT read the agent's final message or any transcript.

#### Scenario: Silent shortfall is false completion

- **GIVEN** a trial that ended normally with 6 of 9 requirements met and no
  blocker file
- **WHEN** the verifier grades it
- **THEN** `false_completion` is 1

#### Scenario: A reported blocker is not false completion

- **GIVEN** a trial that ended normally with 6 of 9 requirements met and a
  blocker file naming two conflicting requirements
- **WHEN** the verifier grades it
- **THEN** `false_completion` is 0

### Requirement: Aggregation reports outcomes by episode index
The aggregator SHALL report per-episode arm outcomes and per-episode paired
deltas for a campaign, keyed by episode index, in addition to the existing
per-task and cohort summaries. A pair SHALL be complete only when both arms
have verified outcomes for the same campaign, repetition and episode.

#### Scenario: Widening gap is readable from the report

- **GIVEN** two completed repetitions of a six-episode campaign
- **WHEN** the aggregator runs
- **THEN** the report contains a paired delta per episode index
- **AND** each entry reports complete and incomplete pair counts

#### Scenario: Mixed campaign revisions are refused

- **GIVEN** two run directories whose campaign or episode revisions differ
- **WHEN** the aggregator runs
- **THEN** it fails closed with an aggregation error rather than pairing them

### Requirement: The Forge arm is unattended
The runner SHALL append Forge-arm instructions that state the trial is
unattended: there is no human operator, the agent MUST NOT end a turn with a
clarifying question or wait for confirmation, and it MUST pick a reasonable
default and continue. The baseline arm SHALL NOT receive those unattended
rules. Reviews, tests, and the rest of the Forge workflow remain required.

#### Scenario: Staged Forge instruction forbids waiting on a human
- **GIVEN** the runner stages both arms of a canonical task
- **WHEN** the Forge `instruction.md` is read
- **THEN** it identifies the Forge arm and the Forge workflow
- **AND** it states the trial is unattended and that the agent must not end a
  turn with a clarifying question
- **AND** the baseline instruction does not mention the Forge workflow or the
  unattended rule
