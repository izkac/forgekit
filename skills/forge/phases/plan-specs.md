# Plan phase — built-in specs engine

For projects with `.forge/config.json` → `plan.engine: specs`. Mirrors the
OpenSpec propose flow without the vendor CLI. Engine root is `plan.dir`
(default `specs/`; set to `openspec` to reuse an OpenSpec tree).

Change lives under `<plan.dir>/changes/<change-name>/`.

## Steps

1. Derive a kebab-case change name from the brainstorm outcome (e.g.
   `add-stripe-refunds`). No date prefix while active.
2. Create the change directory (preferred: CLI scaffold):

   ```bash
   forge change new <change-name> --capability <domain> [--capability <other>]
   ```

   Or create manually under `<plan.dir>/changes/<change-name>/` with the
   **same layout as OpenSpec**:

   **`proposal.md`** (required)

   ```markdown
   # <Change title>

   ## Why
   One or two paragraphs: problem / pressure.

   ## What Changes
   Bulleted scope — behavior, contracts, data.

   ## Capabilities
   - `<domain>`: brief — delta at `specs/<domain>/spec.md`

   ## Impact
   Affected code/areas, risks, migration notes.
   ```

   **`design.md`** (scaffold always; trim or delete when purely mechanical)

   Context, decisions with alternatives, risks.

   **`tasks.md`** (required)

   ```markdown
   # Tasks

   ## 1. <Group name>
   - [ ] 1.1 <Bite-sized task — exact files, expected tests>
   - [ ] 1.2 …

   ## 2. <Group name>
   - [ ] 2.1 …
   ```

   **`specs/<capability>/spec.md`** (delta specs — required for capability work)

   Same format as OpenSpec. There is **no** `deltas/` directory — deltas live
   under `changes/<name>/specs/`:

   ```markdown
   # Delta for <Capability>

   ## ADDED Requirements

   ### Requirement: …
   The system SHALL …

   #### Scenario: …
   - GIVEN …
   - WHEN …
   - THEN …

   ## MODIFIED Requirements
   …

   ## REMOVED Requirements
   …
   ```

   Task-writing rules (from writing-plans practice):
   - Bite-sized: one task = one reviewable step (a test + the code to pass it).
   - Name exact file paths where known.
   - Each task states its verification (test command or observable behavior).
   - Group with `##` sections — Forge reviews per group under `standard` pace.

3. Confirm `tasks.md` exists and at least one delta under `specs/` when the
   change adds/changes behavior. Apply-ready = proposal + tasks + deltas
   (design when non-mechanical).
4. **Spine (always) + orchestration seam** — see [../references/runtime-integrity.md](../references/runtime-integrity.md):

   ```bash
   forge spine init     # mandatory every change — fill rows or set notApplicable
   ```

   Sync-only / docs-only: `"notApplicable": "<reason>"`. Capability work: one row
   per REQ cluster (library → runtime owner → writes → evidence).

   When the spine has real rows, also `forge e2e init` — the executable
   product-loop steps (`e2e.json`) are a **plan deliverable**: author them (or
   task out their authoring) so verify can `forge e2e run` them.

   If the change also involves workers, job queues, handlers, or cross-runtime
   calls, `tasks.md` MUST include:

   - Explicit **wiring** tasks per job kind / entry point → domain pipeline
   - One **product-loop acceptance** task (last implement task, before
     verify) — its output is a green `forge e2e run`

   Missing spine = plan **not** ready. (`forge phase done` refuses without a
   valid spine and, when the spine has rows, a green current e2e run —
   keyword sniffing does not decide.)

5. **Operator brief (mandatory)** — see [../references/operator-brief.md](../references/operator-brief.md):
   write `<plan.dir>/changes/<change-name>/brief.html` — a plain-language,
   self-contained HTML explanation of what will be built (mermaid diagrams
   where helpful), then:

   ```bash
   forge brief stamp    # records specs hash (does NOT auto-open)
   # with more than one session open this refuses — re-run with --session <id>
   ```

   `forge phase implement` hard-refuses while the brief is missing or stale
   (specs edited after stamping → rewrite affected sections and re-stamp).

6. Update session:

   ```bash
   forge phase plan --plan-type specs --openspec <change-name>
   forge phase implement --tasks-total <N>
   ```

   Count tasks from `tasks.md` checkboxes. (`--openspec` carries the change
   name for both engines.)

7. Get user approval on the artefacts before implementing (unless they already said "go").
   The brief is what the operator reviews — tell them its path and that
   `forge brief open` launches it; never open it for them.

## Compatibility

Layout and conventions are identical to OpenSpec:

| Path | Role |
| ---- | ---- |
| `<plan.dir>/specs/<cap>/spec.md` | Source of truth |
| `<plan.dir>/changes/<name>/proposal.md` | Why / what / capabilities / impact |
| `<plan.dir>/changes/<name>/design.md` | Technical approach |
| `<plan.dir>/changes/<name>/tasks.md` | Checklist |
| `<plan.dir>/changes/<name>/specs/<cap>/spec.md` | Delta specs |

Switch engines without moving files:

```bash
forge init --no-openspec --plan-dir openspec
# → .forge/config.json { "plan": { "engine": "specs", "dir": "openspec" } }
```

## Session tracking

Forge session holds orchestration artefacts; the canonical plan lives under
`<plan.dir>/changes/<change-name>/`.
