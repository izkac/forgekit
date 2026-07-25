# Delta for Plan Engine

## ADDED Requirements

### Requirement: Specs engine OpenSpec layout parity
The built-in specs engine SHALL use the same change layout as OpenSpec:
`proposal.md`, `design.md`, `tasks.md`, and delta specs under
`changes/<name>/specs/<capability>/spec.md`, plus a main catalog at
`<plan.dir>/specs/<capability>/spec.md`.

#### Scenario: New change scaffolds deltas
- GIVEN a project with `plan.engine: specs`
- WHEN the operator runs `forge change new <name> --capability <cap>`
- THEN the change directory contains proposal (with Capabilities), design,
  tasks, and `specs/<cap>/spec.md` using ADDED/MODIFIED/REMOVED sections

#### Scenario: Archive merges deltas
- GIVEN a change with delta specs
- WHEN the operator runs `forge change archive <name>`
- THEN requirements are merged into `<plan.dir>/specs/<cap>/spec.md`
- AND the change folder moves to `changes/archive/YYYY-MM-DD-<name>/`

### Requirement: Configurable specs engine root
The project SHALL allow setting the specs-engine root via `plan.dir` so an
existing OpenSpec tree can be reused without moving files.

#### Scenario: Init with --plan-dir
- GIVEN the operator runs `forge init --no-openspec --plan-dir openspec`
- THEN `.forge/config.json` records `{ "plan": { "engine": "specs", "dir": "openspec" } }`
- AND scaffolding targets `openspec/changes/` and `openspec/specs/`
