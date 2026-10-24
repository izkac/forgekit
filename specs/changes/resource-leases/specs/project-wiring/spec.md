# Delta for Project Wiring

## ADDED Requirements

### Requirement: Init wires the lease guard hook
`forge init` SHALL install `forge-lease-guard.mjs` and register it as a Claude Code PreToolUse hook
with matcher `Bash|PowerShell` and as a Cursor `preToolUse` hook with matcher `Shell`. Init SHALL NOT
add any permission allow rule for `forge lease`. The template hook and this repository's
`.claude/hooks/` copy SHALL be byte-identical, and the hook SHALL spawn `forge` as `node <forge.mjs>`
with `shell: false`.

#### Scenario: Claude settings gain the guard
- GIVEN a project without the lease guard
- WHEN `forge init` runs
- THEN `.claude/settings.json` has a PreToolUse entry with matcher `Bash|PowerShell` running `forge-lease-guard.mjs`
- AND `permissions.allow` contains no `forge lease` rule

#### Scenario: Cursor hooks gain the guard
- GIVEN a project being initialised for Cursor
- WHEN `forge init --cursor` runs
- THEN `.cursor/hooks.json` has a `preToolUse` entry with matcher `Shell` running `forge-lease-guard.mjs`

### Requirement: Doctor checks hooks can resolve forge
`forge doctor` SHALL report whether the shipped hooks' resolver finds a `forge.mjs`. When it cannot,
the report SHALL say that hooks (including the lease guard) are inert, and SHALL tell the operator to
put `forge` on the PATH of the process that launches the agent, naming background-service
orchestrators as the common case.

#### Scenario: forge not resolvable
- GIVEN an environment where the hook resolver finds no `forge.mjs`
- WHEN `forge doctor` runs
- THEN it reports the hooks as inert with the PATH fix
