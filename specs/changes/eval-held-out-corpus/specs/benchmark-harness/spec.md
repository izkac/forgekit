# benchmark-harness Specification

## ADDED Requirements

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
