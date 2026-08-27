# Delta for project-wiring

## ADDED Requirements

### Requirement: Vendor-neutral `.agents` install target
`forgekit install` SHALL offer an `agents` environment that installs selected
skills to `~/.agents/skills/<skill>/` with the standard forgekit stamp, and
`forge init` SHALL offer an `agents` target (`--agents` flag and picker entry)
that copies the packaged Forge skill to `<project>/.agents/skills/forge/`
with a stamp, refreshing it on re-run. The target SHALL be skills-only: init
SHALL NOT write command files or hooks for it and SHALL report both as
intentionally skipped. The target SHALL be combinable with any other agent
target in the same run. Forgekit SHALL only manage its own skill directories
under `.agents/skills/` and SHALL NOT read, list, or remove anything else
under `.agents/`.

#### Scenario: Install to the shared user-level root

- **GIVEN** a home directory without `~/.agents`
- **WHEN** `forgekit install --skills forge --agents agents` runs
- **THEN** `~/.agents/skills/forge/SKILL.md` exists
- **AND** the directory carries a `.forgekit.json` stamp
- **AND** `forgekit list` shows the `forge × agents` pair as present

#### Scenario: Project init writes the skill tree and skips commands and hooks

- **GIVEN** a project with no `.agents/` directory
- **WHEN** `forge init --agents` runs
- **THEN** `.agents/skills/forge/SKILL.md` exists with a stamp
- **AND** no `.agents/commands/` and no hook wiring is created
- **AND** the report marks commands and hooks as skipped for this target

#### Scenario: The agents target is not exclusive

- **GIVEN** a project with no wiring
- **WHEN** `forge init --agents --cursor` runs
- **THEN** both `.agents/skills/forge/` and `.cursor/commands/forge.md` exist

#### Scenario: Re-init refreshes a stale project copy

- **GIVEN** `.agents/skills/forge/` containing an older skill tree
- **WHEN** `forge init --agents` runs again
- **THEN** the tree matches the packaged skill and the stamp is current

#### Scenario: Foreign content under .agents is untouched

- **GIVEN** `.agents/skills/other-skill/` and `.agents/agents.md` exist
- **WHEN** `forge init --agents` runs
- **THEN** both are left exactly as they were

### Requirement: Doctor reports the project `.agents` skill copy
When `<project>/.agents/skills/forge/` exists, `forge doctor` SHALL report it —
ok when current against the packaged skill, a warning (not a failure) when
outdated or unversioned, naming `forge init --agents` as the refresh. When the
directory is absent the check SHALL be skipped without affecting the exit
code.

#### Scenario: Outdated project copy warns but does not fail

- **GIVEN** `.agents/skills/forge/` with a stamp from an older version
- **WHEN** `forge doctor` runs
- **THEN** the exit code is unaffected by this check
- **AND** the output names the stale copy and `forge init --agents`

#### Scenario: Absent directory is skipped

- **GIVEN** a project with no `.agents/` directory
- **WHEN** `forge doctor` runs
- **THEN** no `.agents` check appears as failed or warned
