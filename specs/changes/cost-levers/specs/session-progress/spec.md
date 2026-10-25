# Delta for session-progress

## ADDED Requirements

### Requirement: One call closes a task group
`forge group close --group <name>` SHALL run, in order, the group checkpoint (when
`git.checkpoint` is enabled), the reviewer diff range, the review precheck and the reviewer
label, and SHALL print one short block with `reviewTarget`, the precheck verdict, the label
and the resolved tier. A failing step SHALL stop the sequence and name the step.

#### Scenario: Group close with checkpoints enabled
- GIVEN a session with `git.checkpoint: per-group` and group 2 complete
- WHEN `forge group close --group 2` runs
- THEN group 2 is committed and one block prints the review target, precheck result, label and tier

#### Scenario: Precheck fails
- GIVEN a group whose precheck has a FAIL row
- WHEN `forge group close` runs
- THEN it stops after the precheck and names it as the failing step

### Requirement: Short output on request
`forge phase` and `forge status` SHALL print a short human summary with `--brief` and keep
printing the full JSON object by default (existing scripts and tests parse it).

#### Scenario: Brief status
- GIVEN an active session
- WHEN `forge status --brief` runs
- THEN it prints a short summary of a few lines including health, phase, tasks and dispatches

#### Scenario: Default status unchanged
- WHEN `forge status` runs without flags
- THEN it prints the same JSON object as before this change
