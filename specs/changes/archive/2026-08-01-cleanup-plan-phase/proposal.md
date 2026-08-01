# Cleanup Plan-Phase Sessions

## Why

A bare `forge cleanup` can still delete an unfinished session stuck in
triage/plan whose real artefacts live under `specs/changes/<name>/`, not
inside the session directory. `holdsWork` only scans the session dir, so
phaseHistory and host binding disappear while the change dir remains.
Finding F48.

## What Changes

- Treat an unfinished session as holding work when its
  `openspecChange` still exists as an active change directory under the
  configured plan engine root (`specs/changes/<name>/`, not archive).
- Keep `--include-unfinished --session <id>` as the explicit escape hatch.
- Resolve F48.

## Capabilities

- `session-lifecycle`: cleanup retention respects plan-phase change dirs
  (delta: `specs/session-lifecycle/spec.md`)

## Impact

- Code: `packages/cli/src/cleanup-sessions.mjs`, tests in `lib.test.mjs`
  (cleanup cases).
- Risk: sessions with a stale `openspecChange` pointing at a still-present
  change dir stay protected longer — correct for F48; archived changes
  must not count as holding work.
- Migration: none.
- Findings: resolve F48. Analyze-report batch is a separate change.
