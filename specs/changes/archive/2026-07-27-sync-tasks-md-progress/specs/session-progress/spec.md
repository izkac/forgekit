# Spec: session progress from plan checkboxes

## Purpose

Operator-facing forge surfaces must reflect OpenSpec/specs `tasks.md` progress, not a stale session cache.

## Requirements

### Requirement: Plan checkboxes are progress source of truth

When a session links an openspec/specs change whose `tasks.md` contains one or more checkbox task lines, forge SHALL treat the count of `- [x]` / `- [X]` lines as `tasksComplete` and the count of all checkbox lines as `tasksTotal` for fleet, status, and health displays.

#### Scenario: Divergent cache

- **GIVEN** `session.json` has `tasksComplete: 0` and `tasksTotal: 46`
- **AND** the linked `tasks.md` has 24 checked boxes out of 46
- **WHEN** `forge fleet list` or `forge status` runs
- **THEN** progress is shown as 24/46
- **AND** `session.json` is healed to match

### Requirement: Checkbox activity prevents false STALE

Idle/STALE detection SHALL consider the linked `tasks.md` modification time as session activity, alongside `session.updatedAt`.

#### Scenario: Agent ticks boxes without forge phase

- **GIVEN** `session.updatedAt` is older than the idle threshold
- **AND** `tasks.md` was modified within the idle threshold
- **WHEN** health is evaluated
- **THEN** the session is not STALE solely due to idle time
