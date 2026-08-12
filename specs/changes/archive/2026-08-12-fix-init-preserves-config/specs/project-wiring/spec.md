# Delta for Project Wiring

## ADDED Requirements

### Requirement: Init preserves a project's recorded plan engine and ADR setting
When `forge init` runs without an explicit engine flag
(`--openspec` / `--no-openspec`) or ADR flag (`--adr` / `--no-adr`), and the
project's `.forge/config.json` already records that key, init SHALL default to
the recorded value rather than the user default, a prompt, or a non-TTY
fallback. A recorded specs engine SHALL preserve its recorded `plan.dir`. An
explicit flag SHALL still override a recorded value, since a flag is a request
to change the project.

The precedence for each choice, highest first, SHALL be: explicit flag; the
project's recorded value; an existing on-disk signal (an OpenSpec setup for the
engine choice); the user default; the prompt or non-TTY fallback. A project with
no recorded value SHALL be resolved exactly as a first-time init is today.

#### Scenario: A flagless re-init does not convert a recorded specs project

- **GIVEN** a project whose `.forge/config.json` records `plan.engine: specs`,
  `plan.dir: specs`, and `adr.enabled: false`
- **AND** the user's global default is the OpenSpec engine with ADRs enabled
- **WHEN** `forge init --claude` runs with no engine or ADR flag and no TTY
- **THEN** `plan.engine` remains `specs` and `plan.dir` remains `specs`
- **AND** `adr.enabled` remains `false`
- **AND** no ADR scaffolding (`docs/adr/`, a decisions doc, ADR hook scripts) is created

#### Scenario: An explicit flag still changes the project

- **GIVEN** the same recorded-specs project
- **WHEN** `forge init --claude --openspec` runs
- **THEN** `plan.engine` becomes `openspec`

#### Scenario: A recorded ADR-enabled project is preserved

- **GIVEN** a project whose `.forge/config.json` records `adr.enabled: true`
- **AND** the user's global default disables ADRs
- **WHEN** `forge init --claude` runs with no ADR flag and no TTY
- **THEN** `adr.enabled` remains `true`

#### Scenario: A first-time init with no recorded config is unchanged

- **GIVEN** a project with no `.forge/config.json`
- **AND** the user's global default is the OpenSpec engine
- **WHEN** `forge init --claude` runs with no engine flag and no TTY
- **THEN** the engine resolves exactly as it does today (the user default),
  because there is no recorded value to preserve
