# Delta for Session Lifecycle

## ADDED Requirements

### Requirement: Shaped work is re-triaged before the plan is written
After brainstorm, and before change artefacts are produced, Forge SHALL
evaluate the shaped work against the plan-time exit conditions: few tasks, a
single capability, no wired spine rows, and no high-risk surface. When all hold,
Forge SHALL offer to leave rather than produce a proposal, design, tasks, spine
and brief for the change.

#### Scenario: Small shaped work offers an exit

- **GIVEN** brainstorm resolved the work to a two-task, single-capability change
  with no wired spine rows and no high-risk surface
- **WHEN** the plan phase begins
- **THEN** Forge offers to leave Forge for this work
- **AND** no change directory is scaffolded before that offer is answered

#### Scenario: Substantial shaped work proceeds without an offer

- **GIVEN** brainstorm resolved the work to a multi-capability change with wired
  spine rows
- **WHEN** the plan phase begins
- **THEN** no exit is offered and the change is scaffolded as today

#### Scenario: High-risk work never offers an exit

- **GIVEN** shaped work touching authentication, however small
- **WHEN** the plan phase begins
- **THEN** no exit is offered

### Requirement: Leaving Forge is recorded, never silent
When a session leaves Forge through the plan-time exit ramp, it SHALL be
recorded with the terminal phase for skipped work and SHALL carry the resolved
shape as its reason. A session SHALL NOT be abandoned without that record.

#### Scenario: An exited session is countable

- **GIVEN** a session that took the plan-time exit
- **WHEN** the session ledger is read
- **THEN** the session appears with the skipped phase
- **AND** its recorded reason names the task count, capability count and the
  absence of wired spine rows

#### Scenario: The offer is declined

- **GIVEN** a session offered the plan-time exit
- **WHEN** the user chooses to continue with a tracked change
- **THEN** the session proceeds to plan
- **AND** the declined offer is recorded on the session
