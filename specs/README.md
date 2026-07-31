# `specs/` — Forge specs (built-in planning engine)

OpenSpec-compatible change tracking without the OpenSpec CLI. Same **format**
as OpenSpec (proposal / design / tasks / delta specs / main catalog). Managed
by the Forge workflow (see the `forge` skill, `phases/plan-specs.md`).

```
specs/
  specs/<capability>/spec.md          # source of truth (current behavior)
  changes/<change-name>/
    proposal.md                       # Why / What Changes / Capabilities / Impact
    design.md                         # optional — context, decisions, risks
    tasks.md                          # ## groups with - [ ] task checkboxes
    specs/<capability>/spec.md        # DELTA specs (ADDED / MODIFIED / REMOVED)
  changes/archive/YYYY-MM-DD-<change-name>/
```

Conventions (kept identical to OpenSpec so migration stays trivial):

- One change per unit of substantial work; kebab-case change names.
- Delta specs live under `changes/<name>/specs/` — **not** a `deltas/` folder.
- `tasks.md` uses `##` section groups and `- [ ]` checkboxes; Forge counts
  and reviews per group.
- On archive (`forge change archive`), deltas merge into `specs/specs/`, then
  the change folder moves under `changes/archive/`.

Switching from OpenSpec without moving files: set
`.forge/config.json` → `{ "plan": { "engine": "specs", "dir": "openspec" } }`
(or `forge init --no-openspec --plan-dir openspec`).

Migrating the other way: run `openspec init`, keep using the same tree if
`dir` already points at `openspec/`.
