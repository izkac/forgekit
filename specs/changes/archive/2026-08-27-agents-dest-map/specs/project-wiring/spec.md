# Delta for Project Wiring

## MODIFIED Requirements

### Requirement: Vendor-neutral `.agents` install target
`forgekit install` SHALL NOT offer a selectable `agents` environment or a
`--shared` flag. Harnesses that natively discover `~/.agents/skills/`
(Cursor, Codex CLI, GitHub Copilot, Gemini CLI, OpenCode) SHALL install
selected skills to `~/.agents/skills/<skill>/` with the standard forgekit
stamp. Selecting more than one of those harnesses SHALL write each skill to
that destination **once**. Claude Code SHALL keep `~/.claude/skills/<skill>/`.
Windsurf SHALL keep its vendor skill path. `--shared` SHALL fail with an
error that names `--cursor` / `--codex` (or other harness flags). The
interactive picker SHALL pre-check the `.agents`-capable harnesses when
nothing is installed yet. Forgekit SHALL only manage its own skill
directories under `.agents/skills/` and SHALL NOT read, list, or remove
anything else under `.agents/`.

#### Scenario: Install to the shared user-level root

- **GIVEN** a home directory without `~/.agents`
- **WHEN** `forgekit install --skills forge --cursor` runs
- **THEN** `~/.agents/skills/forge/SKILL.md` exists
- **AND** the directory carries a `.forgekit.json` stamp
- **AND** `~/.cursor/skills/forge` is not created

#### Scenario: Two `.agents`-capable harnesses share one dest

- **GIVEN** a home directory without `~/.agents`
- **WHEN** `forgekit install --skills forge --cursor --codex` runs
- **THEN** exactly one copy exists at `~/.agents/skills/forge/`
- **AND** `~/.codex/skills/forge` is not created

#### Scenario: `--shared` fails with guidance

- **WHEN** `forgekit install --shared` is parsed
- **THEN** it fails
- **AND** the error names `--cursor` or `--codex`

#### Scenario: First-run picker pre-checks `.agents`-capable harnesses

- **GIVEN** a home directory with no managed skill installs
- **WHEN** the interactive environment picker is computed
- **THEN** cursor, codex, copilot, gemini, and opencode are pre-checked
- **AND** claude is not pre-checked

#### Scenario: `forge init --agents` fails with guidance

- **WHEN** `forge init --agents` runs
- **THEN** the exit code is non-zero
- **AND** the error names `forgekit install` as where skills are managed

## ADDED Requirements

### Requirement: Shared dest is not deleted while another harness still maps there
Uninstalling or pruning one `.agents`-capable harness SHALL NOT remove
`~/.agents/skills/<skill>/` while another selected or remaining harness
still maps to that destination.

#### Scenario: Uninstall Cursor keeps the dest if Codex remains

- **GIVEN** `~/.agents/skills/forge/` installed via `--cursor --codex`
- **WHEN** `forgekit uninstall --skills forge --agents cursor` runs
- **THEN** `~/.agents/skills/forge/` still exists

### Requirement: Stamped vendor leftovers are retired on `.agents` install
When `forgekit install` writes a skill to `~/.agents/skills/<skill>/`, it
SHALL delete a **stamped** leftover at that skill’s previous vendor path for
each `.agents`-capable harness. An unstamped directory at a vendor path
SHALL be left byte-identical.

#### Scenario: Stamped Cursor vendor copy is retired

- **GIVEN** a stamped `~/.cursor/skills/forge/`
- **WHEN** `forgekit install --skills forge --cursor --force` runs
- **THEN** `~/.cursor/skills/forge/` no longer exists
- **AND** `~/.agents/skills/forge/` exists with a stamp

#### Scenario: Unstamped vendor directory survives

- **GIVEN** `~/.cursor/skills/forge/` without a `.forgekit.json` stamp
- **WHEN** `forgekit install --skills forge --cursor --force` runs
- **THEN** the unstamped vendor directory is left exactly as it was
