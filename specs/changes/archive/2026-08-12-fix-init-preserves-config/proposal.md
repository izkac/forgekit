# Fix: init preserves an existing project's recorded config

## Why

Re-running `forge init` on a project that already recorded its choices
silently overwrites them. The 0.3.40 install note tells people to re-run
`forge init` to pick up new command wording, so this misfires on exactly the
upgrade path being shipped.

Reproduced 2026-08-12 in a scratch project whose `.forge/config.json` recorded
`plan.engine: specs`, `plan.dir: specs`, `adr.enabled: false`, on a machine
whose user default is `openspec` + ADRs on. A flagless non-TTY
`forge init --claude` rewrote it to:

```
plan.engine: openspec      (was specs — and plan.dir was dropped entirely)
adr.enabled: true          (was false)
adr.decisionsDoc: docs/decisions.md   (added)
```

and scaffolded `docs/adr/`, `docs/decisions.md`, and four hook scripts under
`scripts/hooks/` that the project never asked for. A specs-engine project is
now told to plan with OpenSpec, and every later phase routes to the wrong
engine.

The root cause is one flaw in two places. When neither `--openspec/--no-openspec`
nor `--adr/--no-adr` is given, init resolves the choice from **user config and
prompts**, never from **what the project itself already recorded**:

- `resolveInitPlanEngine` (init.mjs ~787) honors an existing OpenSpec *directory*
  (`configured`) but has no equivalent for a recorded `plan.engine: specs`, so a
  specs project with no openspec dir falls through to the user default.
- the ADR block (init.mjs ~865) reads `user.adr` and the TTY prompt but never the
  project's own `adr.enabled`, so a non-TTY run with the user's global ADR on
  flips a project's recorded `adr.enabled: false` back to true.

Explicit flags already win correctly (`--no-openspec --no-adr` was verified to
force specs + disabled). The bug is confined to the flagless default path.

## What Changes

- Re-running `forge init` with no engine/ADR flag on a project that already
  recorded those keys defaults to **what the project recorded**, not the user
  default or a prompt.
- Precedence, highest first: explicit flag → recorded project config → existing
  on-disk signal (`configured` OpenSpec dir) → user default → prompt / non-TTY
  fallback.
- `plan.dir` is preserved when an existing specs engine is honored, rather than
  dropped.
- A first-time `forge init` on a project with no recorded config is unchanged —
  it still asks or uses the user default.

## Capabilities

- `project-wiring`: init becomes non-destructive to a project's recorded plan
  engine and ADR setting — delta at `specs/project-wiring/spec.md`

## Impact

Affected code: `packages/cli/src/init.mjs` (`resolveInitPlanEngine` and the ADR
resolution block). Reads the existing config via `loadProjectConfig` /
`resolveProjectPlanEngine`, both already exported. No config *schema* change —
only which source wins when a value is unspecified on the command line.

Behavior change for users: a flagless re-init stops changing a project that had
already chosen. This is the intended fix. The one visible difference is that a
user whose global default differs from a project's recorded choice no longer
sees init silently convert the project; to change a project's engine they now
pass the explicit flag, which is the correct way to ask for a change.
