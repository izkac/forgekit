# Delta for Worktree Slots

## ADDED Requirements

### Requirement: Each worktree has a stable slot number
`forge slot` SHALL print this checkout's slot: 0 for the repository's main worktree and for non-git
directories; for a linked worktree, its recorded number, or else the lowest free integer ≥ 1. Slots
SHALL be recorded in `<git-common-dir>/forge/slots.json` and allocated under the internal lease
`_slots`, written atomically. Entries whose paths are no longer listed by `git worktree list` SHALL be
pruned when allocating. An unreadable `slots.json` SHALL be rebuilt with a warning.

#### Scenario: Two linked worktrees
- GIVEN a repository with linked worktrees W1 and W2 and no `slots.json`
- WHEN `forge slot` runs in the main checkout, W1, then W2
- THEN it prints 0, 1, 2
- AND running it again in W1 prints 1

#### Scenario: Removed worktree frees its slot
- GIVEN W1 holds slot 1 and W2 holds slot 2
- WHEN W1 is removed with `git worktree remove` and a new worktree W3 runs `forge slot`
- THEN W3 gets slot 1

### Requirement: Slot env templates
`.forge/config.json → slots.env` MAY map variable names to templates. A template SHALL support only
`{slot}` (the slot number) and `{N+slot}` (integer N plus the slot); any other brace expression
SHALL be left verbatim with a warning. `FORGE_SLOT` SHALL always be included.
`forge slot env [--shell dotenv|bash|powershell]` SHALL print the assignments in that syntax
(default `dotenv`).

#### Scenario: Port and database name
- GIVEN `slots.env` is `{ "PORT": "{3000+slot}", "DATABASE_URL": "postgres://localhost/app_{slot}" }`
- WHEN `forge slot env --shell bash` runs in the worktree with slot 2
- THEN it prints `export FORGE_SLOT='2'`, `export PORT='3002'` and `export DATABASE_URL='postgres://localhost/app_2'`

#### Scenario: PowerShell syntax
- GIVEN the same configuration and slot 2
- WHEN `forge slot env --shell powershell` runs
- THEN it prints `$env:PORT = '3002'` among the assignments

### Requirement: Slot env file
When `slots.env` is configured, `forge slot`, `forge new` and the SessionStart reminder SHALL write
`.forge/slot.env` in dotenv syntax, rewriting it only when its content changes. Without `slots.env`
they SHALL NOT create the file.

#### Scenario: File written once
- GIVEN `slots.env` is configured and `.forge/slot.env` already holds the current values
- WHEN `forge slot` runs
- THEN the file's mtime is unchanged

#### Scenario: Not configured
- GIVEN no `slots.env` in `.forge/config.json`
- WHEN `forge new demo` runs
- THEN `.forge/slot.env` does not exist
