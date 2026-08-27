# Project Wiring Spec

## Purpose

Describe this capability.

## Requirements

### Requirement: Doctor detects hooks present on disk but unwired
`forge doctor` SHALL verify, for each agent surface whose hooks directory
exists in the project, that every `forge-*.mjs` hook file on disk is
referenced by a hook `command` in that surface's wiring file — Claude:
`.claude/settings.json` or `.claude/settings.local.json`; Cursor:
`.cursor/hooks.json` — and SHALL fail (exit 1, `checks.hooks.ok: false`)
listing the unwired basenames when any is not.

#### Scenario: Fully unwired project fails doctor

- GIVEN a project with `forge-*.mjs` files in `.claude/hooks/`
- AND a `.claude/settings.json` that references none of them
- WHEN the operator runs `forge doctor --json`
- THEN the exit code is 1
- AND `checks.hooks` lists every forge hook basename as unwired
- AND the message names the snippet file to merge

#### Scenario: Partially wired project fails with the missing subset

- GIVEN `.claude/settings.json` wires only `forge-model-hook.mjs` while three
  other forge hooks exist in `.claude/hooks/`
- WHEN the operator runs `forge doctor`
- THEN the check fails and the unwired list contains exactly the three
  unreferenced basenames

#### Scenario: Wiring via settings.local.json passes

- GIVEN forge hooks referenced only from `.claude/settings.local.json`
- WHEN the operator runs `forge doctor`
- THEN the hook-wiring check passes

#### Scenario: Surface without hooks directory is skipped

- GIVEN a project with no `.claude/hooks/` and no `.cursor/hooks/`
- WHEN the operator runs `forge doctor`
- THEN the hook-wiring check reports ok with `skipped: true`
- AND the doctor exit code is unaffected by the check

#### Scenario: Unparseable wiring file fails while hooks exist

- GIVEN forge hooks in `.claude/hooks/` and a malformed `.claude/settings.json`
- WHEN the operator runs `forge doctor`
- THEN the hook-wiring check fails and the message includes the parse problem

### Requirement: Session bootstrap warns on unwired hooks
The warn-only doctor path used by `forge new` SHALL print the hook-wiring
failure (unwired basenames) without changing the warn-only exit behaviour.

#### Scenario: forge new surfaces the unwired state

- GIVEN a project in the unwired state
- WHEN the operator runs `forge new some-slug`
- THEN stderr contains the unwired hook basenames
- AND session creation still succeeds

### Requirement: Init merges the hooks snippet into settings.json
Existing groups in `settings.json` are never reordered. Forge-owned retired hook basenames (currently `forge-triage-hook.mjs`) are an explicit exception: they are removed as specified under “Init retires leftover auto-triage wiring”. Unrelated user entries remain untouched.

#### Scenario: Re-running init adds nothing

*(unchanged)*

#### Scenario: Existing user hooks are preserved

*(unchanged)*

### Requirement: Hooks never pass untrusted text through a shell
The remaining prompt-bearing hook is `forge-prompt-hook.mjs`. The retired `forge-triage-hook.mjs` is no longer in the shipped set.

#### Scenario: The shipped hook and the project copy stay identical

- **GIVEN** the template hooks under `templates/project/claude/hooks/`
- **WHEN** compared against this repo's own `.claude/hooks/` copies
- **THEN** they are byte-identical
- **AND** `forge-triage-hook.mjs` is absent from both trees

### Requirement: Portable declared CI matrix
The project SHALL keep tests portable across every operating system and Node version declared by its CI matrix. Tests of filesystem denial SHALL use deterministic coded failures rather than permission semantics unavailable on a declared host.

#### Scenario: Windows and Ubuntu enforce the same product assertions

- GIVEN the repository is tested on Ubuntu and Windows with supported Node versions
- WHEN the CI workflow runs lint, tests, and smoke checks
- THEN every required job completes without unexplained test failures
- AND platform-specific fixtures exercise the same production fail-closed behavior
- AND test portability changes do not weaken production error handling

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

### Requirement: Auto-triage hook is not shipped
`forge init --claude` SHALL NOT copy `forge-triage-hook.mjs` into the project and SHALL NOT register it in `forge-hooks.snippet.json` or `.claude/settings.json`. The generated UserPromptSubmit wiring SHALL still include `forge-prompt-hook.mjs`.

#### Scenario: Fresh Claude init has no triage hook

- **GIVEN** a project with no `.claude/` directory
- **WHEN** `forge init --claude` runs
- **THEN** `.claude/hooks/forge-triage-hook.mjs` does not exist
- **AND** neither `forge-hooks.snippet.json` nor `settings.json` references `forge-triage-hook.mjs`
- **AND** `forge-prompt-hook.mjs` is present and wired on UserPromptSubmit

### Requirement: Init retires leftover auto-triage wiring
`forge init --claude` and `forge doctor --install` SHALL delete `.claude/hooks/forge-triage-hook.mjs` when that file exists, SHALL remove hook entries whose command basename is exactly `forge-triage-hook.mjs` from `.claude/settings.json` and `.claude/settings.local.json` when those files parse as JSON, and SHALL rewrite `forge-hooks.snippet.json` so it no longer lists the retired hook. Entries whose basename is a wrapper (for example `my-forge-triage-hook.mjs`) SHALL be left in place. Other user hook entries SHALL be left in place.

#### Scenario: Leftover hook is unwired and deleted

- **GIVEN** a project whose `.claude/hooks/` contains `forge-triage-hook.mjs`
- **AND** `.claude/settings.json` registers that file on UserPromptSubmit
- **WHEN** `forge init --claude` runs
- **THEN** the hook file is gone
- **AND** `settings.json` no longer references `forge-triage-hook.mjs`
- **AND** `forge-prompt-hook.mjs` remains wired

#### Scenario: Wrapper-named hook is not stripped

- **GIVEN** settings.json contains a command whose basename is `my-forge-triage-hook.mjs`
- **WHEN** retired-hook stripping runs
- **THEN** that command is still present

### Requirement: Doctor ignores leftover retired hook files
`forge doctor` SHALL treat `forge-triage-hook.mjs` as absent when listing forge hooks on disk. A leftover copy SHALL NOT appear as unwired and SHALL NOT fail the hook-wiring check.

#### Scenario: Leftover retired file does not fail doctor

- **GIVEN** `.claude/hooks/forge-triage-hook.mjs` exists
- **AND** no other forge hooks are present
- **WHEN** `forge doctor` runs the hook-wiring check
- **THEN** the check is skipped or ok
- **AND** `forge-triage-hook.mjs` is not listed as unwired

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
