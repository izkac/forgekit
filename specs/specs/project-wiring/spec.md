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

### Requirement: Hooks never pass untrusted text through a shell
A hook that spawns `forge` with caller-supplied text — the user's prompt, a
file path, any value it did not author — SHALL NOT use a shell on platforms
where one is unnecessary. Node joins argv into a command string when
`shell: true`, without quoting, so any metacharacter in that text is
interpreted rather than passed through.

A shell SHALL be used only on win32, where `forge` resolves to a `.cmd` shim
and cannot be spawned directly, and quoting SHALL be confined to that branch.

Prompt text containing shell metacharacters SHALL reach `forge` unchanged.
The realistic trigger is not an attacker: a backtick or a semicolon in a
pasted code snippet is ordinary prompt content, and it fires on every
`UserPromptSubmit` in a wired project.

#### Scenario: Metacharacters in a prompt are not executed

- GIVEN a wired project
- WHEN a user prompt containing `; touch <marker> #` is submitted
- THEN no marker file is created

#### Scenario: A prompt containing metacharacters is relayed intact

- GIVEN a prompt containing a backtick, `$(…)`, a semicolon, a pipe and quotes
- WHEN the hook relays it to `forge`
- THEN `forge` receives the prompt text unchanged

#### Scenario: The shipped hook and the project copy stay identical

- GIVEN the template hooks under `templates/project/claude/hooks/`
- WHEN compared against this repo's own `.claude/hooks/` copies
- THEN they are byte-identical
