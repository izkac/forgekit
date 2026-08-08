# Delta for Project Wiring

## ADDED Requirements

### Requirement: Init merges the hooks snippet into settings.json
`forge init` SHALL structurally merge the generated hooks snippet into
`.claude/settings.json` — creating the file when missing, appending only
hook entries whose commands are not already referenced, and never removing
or reordering existing user entries. The merge SHALL be idempotent. When
`.claude/settings.json` exists but cannot be parsed, init SHALL refuse to
write it and print the manual merge instruction instead. `forge doctor
--install` SHALL perform the same merge. The snippet file SHALL still be
written for transparency.

#### Scenario: Fresh project ends up wired

- GIVEN a project with no `.claude/settings.json`
- WHEN the operator runs `forge init`
- THEN `.claude/settings.json` exists and references every forge hook on disk
- AND `forge doctor` hook-wiring check passes

#### Scenario: Existing user hooks are preserved

- GIVEN a `.claude/settings.json` with a user-defined PostToolUse hook
- WHEN `forge init` runs
- THEN the user hook entry is unchanged
- AND the forge hooks are appended

#### Scenario: Re-running init adds nothing

- GIVEN a project already wired by `forge init`
- WHEN `forge init` runs again
- THEN `.claude/settings.json` is structurally unchanged

#### Scenario: Malformed settings are never overwritten

- GIVEN an unparseable `.claude/settings.json`
- WHEN `forge init` runs
- THEN the file is left byte-identical
- AND the output names the snippet file and the manual merge step
