# Tasks

## 1. Engine-aware live change dir (F73)

- [x] 1.1 RED: aged scaffold-only plan session with
      `.forge/config.json` `{ plan: { engine: "openspec" } }` (no `dir`) and a
      live `openspec/changes/<name>/` must survive bare cleanup. Verify RED.
- [x] 1.2 GREEN: `hasLiveChangeDir` uses `resolveProjectPlanEngine`. Same
      tests green; existing specs-engine F48 case still passes. Resolve F73.

## 2. Product-loop e2e

- [x] 2.1 Extend or add e2e covering openspec-engine (no plan.dir) retention.
      Status line. `forge e2e run` green.
