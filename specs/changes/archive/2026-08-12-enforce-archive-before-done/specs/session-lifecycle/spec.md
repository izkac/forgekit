# Delta for Session Lifecycle

## ADDED Requirements

### Requirement: A finished change is filed before the session is done
`forge phase done` and `forge phase finish` SHALL refuse the transition when the
session names a change whose directory still exists live under
`<plan.dir>/changes/<name>/`. The live path SHALL be resolved with no archive
fallback, so a change that has been archived satisfies the gate and one that has
not cannot. The refusal message SHALL name the remedy for the session's own plan
engine: `forge change archive <name>` for the specs engine, `openspec archive`
for OpenSpec.

The gate SHALL apply only at `done` and `finish`. `forge integrity-check` and
`forge score` SHALL NOT report an unarchived change as a problem at any phase,
because the documented finish sequence runs them before the archive step.

#### Scenario: A complete but unfiled change stops at done

- **GIVEN** a session with all tasks complete and `openspecChange` `example-change`
- **AND** `<plan.dir>/changes/example-change/` still exists
- **WHEN** `forge phase done` runs
- **THEN** it exits non-zero without recording phase `done`
- **AND** the message names `forge change archive example-change`

#### Scenario: An archived change passes

- **GIVEN** the same session
- **AND** the change exists only under `<plan.dir>/changes/archive/<date>-example-change/`
- **WHEN** `forge phase done` runs
- **THEN** the transition succeeds

#### Scenario: An OpenSpec session is told the OpenSpec command

- **GIVEN** a session whose `planType` is `openspec` with a live change dir
- **WHEN** `forge phase done` runs
- **THEN** the refusal names `openspec archive`
- **AND** it does not name `forge change archive`

#### Scenario: A session with no tracked change is unaffected

- **GIVEN** a session whose `openspecChange` is unset
- **WHEN** `forge phase done` runs
- **THEN** the archive gate raises no problem

#### Scenario: Mid-flight integrity runs stay quiet

- **GIVEN** a session at implement phase with a live change dir
- **WHEN** `forge integrity-check` runs
- **THEN** no problem is reported about the change being unarchived
- **AND** `forge score` does not deduct integrity points for it

### Requirement: An unarchived finish is waived by name and recorded
`forge phase done|finish` SHALL accept `--archive-waived "<reason>"`, which
allows the transition with the change still live and records the reason as
`session.archiveWaived`. The field SHALL be written into `.forge/sessions.jsonl`
so the decision outlives session cleanup. An empty or missing reason SHALL NOT
satisfy the flag.

Waiving the archive SHALL NOT set `session.incompleteReason`, which states that
the work did not finish and would be false for a complete change that was merely
left unfiled.

#### Scenario: A named waiver passes the gate

- **GIVEN** a complete session with a live change dir
- **WHEN** `forge phase done --archive-waived "held live for the follow-up tranche"` runs
- **THEN** the transition succeeds
- **AND** `session.archiveWaived` holds that reason
- **AND** `session.incompleteReason` is unset

#### Scenario: The waiver reaches the ledger

- **GIVEN** a session finished with `--archive-waived`
- **WHEN** its `.forge/sessions.jsonl` row is written
- **THEN** the row carries the `archiveWaived` reason

#### Scenario: A bare flag does not waive

- **GIVEN** a complete session with a live change dir
- **WHEN** `forge phase done --archive-waived` runs with no reason
- **THEN** the archive gate still refuses the transition
