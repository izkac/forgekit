# Delta for Project Wiring

## MODIFIED Requirements

### Requirement: Vendor-neutral `.agents` install target
`forgekit install` SHALL offer an `agents` environment that installs selected
skills to `~/.agents/skills/<skill>/` with the standard forgekit stamp, and
SHALL treat it as the default environment: it SHALL be the first picker entry
and SHALL be pre-checked in the interactive environment picker even when no
managed installs exist yet. A `--shared` flag SHALL select it, equivalent to
`--agents agents`. Per-tool environments (Cursor, Codex, …) SHALL remain
selectable alongside it. `forge init` SHALL NOT offer a project-level `agents`
target: the `--agents` flag SHALL fail with an error that names
`forgekit install` as the replacement, and the init environment picker SHALL
NOT list the `agents` environment. Forgekit SHALL only manage its own skill
directories under `.agents/skills/` and SHALL NOT read, list, or remove
anything else under `.agents/`.

#### Scenario: Install to the shared user-level root

- **GIVEN** a home directory without `~/.agents`
- **WHEN** `forgekit install --skills forge --agents agents` runs
- **THEN** `~/.agents/skills/forge/SKILL.md` exists
- **AND** the directory carries a `.forgekit.json` stamp
- **AND** `forgekit list` shows the `forge × agents` pair as present

#### Scenario: The shared root is the pre-checked default in the picker

- **GIVEN** a home directory with no managed skill installs
- **WHEN** the interactive environment picker is computed
- **THEN** `agents` is the first choice and is pre-checked
- **AND** no per-tool environment is pre-checked

#### Scenario: `--shared` selects the shared root

- **WHEN** `forgekit install --skills forge --shared` is parsed
- **THEN** the selected environments equal `['agents']`

#### Scenario: `forge init --agents` fails with guidance

- **WHEN** `forge init --agents` runs
- **THEN** the exit code is non-zero
- **AND** the error names `forgekit install` as where skills are managed

### Requirement: Doctor reports the project `.agents` skill copy
When `<project>/.agents/skills/forge/` exists **with a forgekit stamp**,
`forge doctor` SHALL warn (not fail) that it is a legacy project copy, naming
`forge init` (which retires it) or manual deletion. When the directory exists
without a forgekit stamp it SHALL be ignored as foreign content: no check
output, no warning. When the directory is absent the check SHALL be skipped
without affecting the exit code.

#### Scenario: Stamped legacy copy warns but does not fail

- **GIVEN** `.agents/skills/forge/` carrying a `.forgekit.json` stamp
- **WHEN** `forge doctor` runs
- **THEN** the exit code is unaffected by this check
- **AND** the output calls the copy legacy and names `forge init` as the cleanup

#### Scenario: Unstamped directory is ignored

- **GIVEN** `.agents/skills/forge/` without a `.forgekit.json` stamp
- **WHEN** `forge doctor --json` runs
- **THEN** the report contains no `agentsSkill` check

#### Scenario: Absent directory is skipped

- **GIVEN** a project with no `.agents/` directory
- **WHEN** `forge doctor` runs
- **THEN** no `.agents` check appears as failed or warned

## ADDED Requirements

### Requirement: Init retires the stamped project `.agents` skill copy
`forge init` SHALL delete `<project>/.agents/skills/forge/` when that
directory carries a `.forgekit.json` stamp, and SHALL report the retirement in
its JSON report and human-readable output. A directory at that path without a
forgekit stamp SHALL be left byte-identical, as SHALL all other content under
`.agents/`.

#### Scenario: Stamped copy is retired on the next init

- **GIVEN** a project with a stamped `.agents/skills/forge/` from 0.3.48
- **WHEN** `forge init --cursor` runs
- **THEN** `.agents/skills/forge/` no longer exists
- **AND** the report marks the copy as retired

#### Scenario: Unstamped and foreign content survive

- **GIVEN** `.agents/skills/forge/` without a stamp and `.agents/agents.md`
- **WHEN** `forge init --cursor` runs
- **THEN** both are left exactly as they were
