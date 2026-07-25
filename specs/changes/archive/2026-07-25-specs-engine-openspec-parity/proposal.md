# Specs Engine Openspec Parity

## Why

The built-in specs engine claimed OpenSpec-compatible layout but omitted delta
specs (`changes/<name>/specs/<cap>/spec.md`) and the main capability catalog
(`<plan.dir>/specs/`). Projects switching from OpenSpec also needed a way to
point the engine root at an existing `openspec/` tree without moving files.

## What Changes

- Scaffold and document full OpenSpec-format layout for the specs engine
  (proposal Capabilities, design.md, delta specs, main catalog).
- `forge change archive` merges deltas into `<plan.dir>/specs/` before moving
  the change (OpenSpec archive parity); `--no-sync` to skip.
- `forge init --plan-dir <path>` sets `plan.dir` (e.g. `openspec`).

## Capabilities

- `plan-engine`: engine root path + OpenSpec-format scaffold/archive sync
  (delta: `specs/plan-engine/spec.md`)

## Impact

- Specs-engine projects get format-compatible artefacts with OpenSpec.
- Switching OpenSpec → built-in: `forge init --no-openspec --plan-dir openspec`.
- Doctor requires `<plan.dir>/specs/` as well as `changes/`.
