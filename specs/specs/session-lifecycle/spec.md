# Session Lifecycle Spec

## Purpose

Describe this capability.

## Requirements

### Requirement: Cleanup treats a live plan change dir as held work
An unfinished Forge session whose `openspecChange` names an existing
directory under `<plan.dir>/changes/<name>/` (not under `changes/archive/`)
SHALL be treated as holding work for cleanup retention, even when the
session directory contains only Forge scaffold files.

#### Scenario: Aged plan session with live change dir is retained

- GIVEN an unfinished session older than retention
- AND `session.openspecChange` is `example-change`
- AND `<plan.dir>/changes/example-change/` exists
- AND the session directory holds only scaffold files
- WHEN `forge cleanup` runs without `--include-unfinished`
- THEN that session directory is not removed

#### Scenario: Explicit unfinished delete still works

- GIVEN the same session as above
- WHEN `forge cleanup --include-unfinished --session <id>` runs
- THEN that session directory is removed

#### Scenario: Archived change does not protect

- GIVEN `openspecChange` names a change that exists only under
  `changes/archive/…`
- AND the session directory holds only scaffold files
- WHEN bare `forge cleanup` ages the unfinished session out
- THEN retention may remove the session (change-dir gate does not apply)

### Requirement: Cleanup plan root follows the project plan engine
When resolving whether an `openspecChange` names a live change directory,
cleanup SHALL use the project plan engine root from
`resolveProjectPlanEngine` (with user-default disabled). An OpenSpec project
whose config has `plan.engine` of `openspec` and no `plan.dir` SHALL look
under `openspec/changes/<name>/`, not `specs/changes/<name>/`.

#### Scenario: OpenSpec engine without plan.dir retains plan session

- GIVEN `.forge/config.json` contains `{ "plan": { "engine": "openspec" } }`
- AND an unfinished aged session with `openspecChange` `example-change`
- AND `openspec/changes/example-change/` exists
- AND the session directory holds only scaffold files
- WHEN bare `forge cleanup` runs
- THEN that session directory is not removed

### Requirement: Checkpoint refuses foreign untracked change dirs
`forge checkpoint` SHALL refuse to stage when the working tree has untracked
paths under `<plan.dir>/changes/<other>/` where `<other>` is not the session's
`openspecChange` and is not `archive`. The refusal SHALL list those paths.
It SHALL NOT commit another change's in-progress untracked files under this
session's checkpoint subject.

#### Scenario: Sibling untracked change dir blocks checkpoint

- GIVEN an active session with openspecChange `my-change`
- AND an untracked file under `specs/changes/other-change/`
- WHEN forge checkpoint runs
- THEN it exits non-zero without creating a commit
- AND the message names the foreign path(s)

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
