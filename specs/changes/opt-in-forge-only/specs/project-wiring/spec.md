# Delta for project-wiring

## ADDED Requirements

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

## MODIFIED Requirements

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
