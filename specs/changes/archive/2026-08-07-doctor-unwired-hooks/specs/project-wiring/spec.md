# Delta for Project Wiring

## ADDED Requirements

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
