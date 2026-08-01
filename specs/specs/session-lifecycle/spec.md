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
