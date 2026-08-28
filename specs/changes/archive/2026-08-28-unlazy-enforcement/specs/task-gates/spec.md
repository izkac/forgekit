# Delta for Task Gates

## ADDED Requirements

### Requirement: Opt-in per-group executable gates

The system SHALL provide `forge gate init|check|status` operating on
`gates.json` in the change directory (one entry per `tasks.md` group, e2e
step semantics: exit 0 AND expect regex match), recording results with a
staleness hash — active only when `.forge/config.json` → `gates.enabled`
is true.

#### Scenario: Opt-in wall

- GIVEN a project without `gates.enabled: true`
- WHEN any `forge gate` subcommand runs
- THEN it exits with a one-line "not enabled" message and writes nothing

#### Scenario: Green gate records current evidence

- GIVEN an enabled project and a gates.json group whose check passes with
  matching expect
- WHEN `forge gate check --group <id>` runs
- THEN session `gate-results.json` records the group green with a
  `checksHash` of the group's check+expect

#### Scenario: Edited gate invalidates old evidence

- GIVEN a green recorded group whose check or expect is later edited
- WHEN `forge gate status` runs
- THEN the group reports stale, not met

### Requirement: Integrity gate on completed tasks

When gates are enabled and `gates.json` has non-empty checks,
`forge integrity-check` SHALL fail while any group lacks green, current
gate results — but only once the session reports all tasks complete.

#### Scenario: Partial progress never gates

- GIVEN an enabled project mid-implement with open tasks
- WHEN `forge integrity-check` runs
- THEN gate results are not required

#### Scenario: Completion requires green gates

- GIVEN an enabled project with all tasks ticked and a red, stale, or
  missing gate result for any group
- WHEN `forge integrity-check` runs
- THEN it exits non-zero naming the group

### Requirement: Gate artifacts are tamper-guarded

`gates.json` and `gate-results.json` SHALL be classified as guarded
integrity artifacts (like `e2e.json` / `e2e-results.json`), regardless of
tracking state, so a fake green result cannot be written by hand.

#### Scenario: Hand-editing gate results is a tamper

- GIVEN an active session in the guard's enforcement window
- WHEN a tool call edits `gates.json` or `gate-results.json`
- THEN the guarded-file classifier denies it (`integrity-artifact:<name>`)
