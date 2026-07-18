# Plan phase — built-in specs engine

For projects with `.forge/config.json` → `plan.engine: specs`. Mirrors the
OpenSpec propose flow without the vendor CLI. Change lives under
`<specsDir>/changes/<change-name>/` (default `specs/changes/…`).

## Steps

1. Derive a kebab-case change name from the brainstorm outcome (e.g.
   `add-stripe-refunds`). No date prefix while active.
2. Create the change directory (preferred: CLI scaffold):

   ```bash
   forge change new <change-name>
   ```

   Or create manually under `<specsDir>/changes/<change-name>/` with:

   **`proposal.md`** (required)

   ```markdown
   # <Change title>

   ## Why
   One or two paragraphs: problem / pressure.

   ## What Changes
   Bulleted scope — behavior, contracts, data.

   ## Impact
   Affected code/areas, risks, migration notes.
   ```

   **`design.md`** (only when there are real design decisions)

   Context, decisions with alternatives, risks. Skip for mechanical changes.

   **`tasks.md`** (required)

   ```markdown
   # Tasks

   ## 1. <Group name>
   - [ ] 1.1 <Bite-sized task — exact files, expected tests>
   - [ ] 1.2 …

   ## 2. <Group name>
   - [ ] 2.1 …
   ```

   Task-writing rules (from writing-plans practice):
   - Bite-sized: one task = one reviewable step (a test + the code to pass it).
   - Name exact file paths where known.
   - Each task states its verification (test command or observable behavior).
   - Group with `##` sections — Forge reviews per group under `standard` pace.

3. Confirm `tasks.md` exists and the change is apply-ready.
4. **Orchestration seam check** (required before apply-ready) — see [../references/runtime-integrity.md](../references/runtime-integrity.md):

   If the change involves workers, job queues, handlers, or cross-runtime calls, `tasks.md` MUST include:

   - Explicit **wiring** tasks per job kind / entry point → domain pipeline
   - One **E2E fixture** acceptance task

   Missing seam = plan **not** ready. Add the tasks before proceeding to implement.

5. Update session:

   ```bash
   forge phase plan --plan-type specs --openspec <change-name>
   forge phase implement --tasks-total <N>
   ```

   Count tasks from `tasks.md` checkboxes. (`--openspec` carries the change
   name for both engines.)

6. Get user approval on the artefacts before implementing (unless they already said "go").

## Compatibility

Layout and conventions are deliberately identical to OpenSpec
(`proposal.md` / `design.md` / `tasks.md`, archive on finish). Migration:
`openspec init`, then move `specs/changes/*` into `openspec/changes/`.

## Session tracking

Forge session holds orchestration artefacts; the canonical plan lives under
`<specsDir>/changes/<change-name>/`.
