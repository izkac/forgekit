# Tasks

## 1. Format parity (deltas + catalog)
- [x] 1.1 Add `specs-sync.mjs` for ADDED/MODIFIED/REMOVED merge + delta template
- [x] 1.2 Scaffold main `<plan.dir>/specs/` in `scaffoldSpecs`
- [x] 1.3 `forge change new` writes design.md, Capabilities, and `--capability` delta stubs
- [x] 1.4 `forge change archive` merges deltas then moves (with `--no-sync`)

## 2. Configurable engine root
- [x] 2.1 `normalizePlanDir` + honor `plan.dir` through scaffold/init/change/doctor
- [x] 2.2 `forge init --plan-dir <path>` for specs engine

## 3. Docs + templates
- [x] 3.1 Update plan-specs, finish, plan-routing, README, usage, forge.md
- [x] 3.2 Point forge-plan/apply/build templates at `<plan.dir>` + deltas
