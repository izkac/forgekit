# Delta for Benchmark Harness

## ADDED Requirements

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
