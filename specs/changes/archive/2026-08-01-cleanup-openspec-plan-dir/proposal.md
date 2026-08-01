# Cleanup OpenSpec plan-dir fallback (F73)

## Why

F48 taught cleanup to treat a live change dir as held work, but
`hasLiveChangeDir` falls back to `DEFAULT_SPECS_DIR` (`specs`) when
`plan.dir` is unset. OpenSpec projects commonly have
`{ plan: { engine: "openspec" } }` with no `dir`, so aged plan sessions
under `openspec/changes/<name>/` are still deleted. Finding **F73**.

## What Changes

- Resolve the plan root via `resolveProjectPlanEngine(cwd, { useUserDefault: false })`
  so `engine: openspec` without `dir` uses `openspec/`, not `specs/`.
- Keep slash rejection and live-only (not archive) semantics.
- Resolve F73.

## Capabilities

- `session-lifecycle`: cleanup plan-root resolution matches the project engine
  (delta: `specs/session-lifecycle/spec.md`)

## Impact

- Code: `packages/cli/src/cleanup-sessions.mjs`, tests in `lib.test.mjs`.
- Risk: projects with no plan block still default via resolveProjectPlanEngine
  (openspec) — same as the rest of Forge, not a new default.
- Findings: resolve F73.
