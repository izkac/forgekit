# Delta for TDD Evidence

## ADDED Requirements

### Requirement: Subagent-targeted executed evidence
Forge SHALL instruct implementers to execute TDD against an explicit session and task and SHALL instruct reviewers to validate the resulting executed ledger under the same target.

#### Scenario: Implementer records a cycle for the coordinator session
- GIVEN a coordinator dispatches a behavior-changing task
- WHEN the implementer runs RED and GREEN
- THEN both commands name the coordinator session and task explicitly
- AND the implementer reports the durable ledger path
- AND the reviewer treats plain evidence as supplemental rather than a substitute

### Requirement: Incompatible plain evidence fails early
Forge SHALL refuse plain evidence when executed pairing is enabled and the task has no executed ledger, unless the operator makes a valid no-TDD declaration.

#### Scenario: Plain evidence cannot become a dead-end artifact
- GIVEN a flagged session and task with no executed ledger
- WHEN `forge evidence` is invoked without `--no-tdd`
- THEN it exits nonzero and writes nothing
- AND it directs the implementer to `forge tdd run`

#### Scenario: Compatible evidence remains accepted
- GIVEN a legacy session, valid no-TDD declaration, or existing executed ledger
- WHEN plain evidence is recorded
- THEN Forge preserves the existing behavior

### Requirement: Executed stamp receipt
After writing a TDD stamp, Forge SHALL report the ledger path, expected outcome, child exit, and whether the expectation matched.
