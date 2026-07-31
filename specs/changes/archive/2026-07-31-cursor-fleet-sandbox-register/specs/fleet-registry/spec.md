# Delta for fleet-registry

## ADDED Requirements

### Requirement: Registration failure under a write-blocked home leaves a pending stamp
When mirroring a session into the machine fleet registry fails because the
registry path cannot be written (`EACCES`, `EPERM`, or an equivalent permission
error), the system SHALL write a pending stamp at
`<project>/.forge/sessions/<sessionId>/fleet-pending.json` and SHALL emit a
stderr warning that names the failure and, when a Cursor sandbox environment
marker is present, tells the operator to re-run forge with unrestricted
permissions and/or run `forge fleet sync`.

A successful registry write SHALL remove any pending stamp for that session.

#### Scenario: Sandboxed register cannot write the registry

- **GIVEN** a project session being saved
- **AND** writing `~/.forgekit/fleet/sessions/` fails with permission denied
- **WHEN** registration is attempted
- **THEN** `fleet-pending.json` exists under that session directory
- **AND** stderr warns that the session will not appear in `forge fleet`
- **AND** the session save itself still succeeds

#### Scenario: Successful register clears pending

- **GIVEN** a session directory that already has `fleet-pending.json`
- **WHEN** registration writes the registry entry successfully
- **THEN** `fleet-pending.json` is removed

### Requirement: Reminder flushes pending registrations when writable
`forge reminder` SHALL attempt to register any session under the project’s
`.forge/sessions/` that still has a pending stamp. Each successful register
SHALL clear that session’s stamp. Failures SHALL remain advisory and SHALL NOT
block the reminder.

#### Scenario: Pending session becomes registrable

- **GIVEN** an active project with a session that has `fleet-pending.json`
- **AND** the fleet registry is writable
- **WHEN** `forge reminder` runs
- **THEN** the session appears in the fleet registry
- **AND** the pending stamp is gone

### Requirement: Fleet sync re-registers project sessions
`forge fleet sync` SHALL load every `session.json` under the current project’s
`.forge/sessions/` and attempt registration for each. It SHALL report how many
registered, failed, or remain pending, and SHALL clear pending stamps on
success.

#### Scenario: Sync recovers an unregistered session

- **GIVEN** a project session on disk that is missing from the fleet registry
- **AND** the registry is writable
- **WHEN** the operator runs `forge fleet sync` in that project
- **THEN** the session is present in the fleet registry

### Requirement: Cursor init wires sessionStart hooks
`forge init` for Cursor SHALL ensure `.cursor/hooks.json` exists with a
`sessionStart` command that runs the project’s `forge-session-start` hook.
When `.cursor/hooks.json` already exists, the system SHALL merge that entry
without removing unrelated hooks. A documentation snippet MAY still be written.

#### Scenario: Fresh Cursor init

- **GIVEN** a project with no `.cursor/hooks.json`
- **WHEN** `forge init --cursor` runs
- **THEN** `.cursor/hooks.json` contains a sessionStart hook for forge-session-start

#### Scenario: Existing hooks are preserved

- **GIVEN** a `.cursor/hooks.json` with an unrelated stop hook
- **WHEN** `forge init --cursor` runs
- **THEN** the stop hook remains
- **AND** a forge sessionStart entry is present
