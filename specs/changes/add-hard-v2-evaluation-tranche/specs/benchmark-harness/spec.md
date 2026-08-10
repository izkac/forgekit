# Delta for Benchmark Harness

## ADDED Requirements

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
