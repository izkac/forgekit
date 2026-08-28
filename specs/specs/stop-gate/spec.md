# Stop Gate Spec

## Purpose

Describe this capability.

## Requirements

### Requirement: Turn-end completion backstop
The system SHALL provide a Claude Code `Stop` hook template
(`forge-stop-hook.mjs`), installed by `forge init --claude`, that blocks
turn-end only when the active Forge session claims completion while
`forge integrity-check` fails.

#### Scenario: Blocks a false completion claim

- GIVEN an active session with tasksComplete >= tasksTotal (or phase in
  verify/review/finish)
- AND `forge integrity-check` exits non-zero
- WHEN the Stop hook runs
- THEN it emits `{"decision":"block","reason":…}` naming the integrity
  problems and the commands to fix them

#### Scenario: Never blocks mid-implement work

- GIVEN an active session in implement with open tasks
- WHEN the Stop hook runs
- THEN it exits 0 without spawning any child process

#### Scenario: Fails open

- GIVEN a missing, unreadable, or corrupt session/config file, or any
  internal error
- WHEN the Stop hook runs
- THEN it exits 0 and never blocks

#### Scenario: Loop protection

- GIVEN hook input with `stop_hook_active: true`
- WHEN the Stop hook runs
- THEN it exits 0 regardless of session state

#### Scenario: Operator off-switch

- GIVEN `.forge/config.json` → `hooks.stopGate: "off"`
- WHEN the Stop hook runs
- THEN it exits 0 in the fast path
