# Plan phase — OpenSpec

Thin wrapper around the project **`openspec-propose`** skill (or `/opsx:propose`).

## Steps

1. Derive change name with correct product prefix (`openspec/config.yaml` (if the project uses OpenSpec prefixes)).
2. Run `openspec-propose` / `/opsx:propose <prefix>-<slug>`.
3. Confirm `tasks.md` exists and change is apply-ready.
4. **Spine (always) + orchestration seam** — see [../references/runtime-integrity.md](../references/runtime-integrity.md):

   ```bash
   forge spine init     # mandatory every change — fill rows or set notApplicable
   ```

   Sync-only / docs-only: `"notApplicable": "<reason>"`. Capability work: one row
   per REQ cluster (library → runtime owner → writes → evidence).

   If the change also involves workers, job queues, handlers, or cross-runtime
   calls, `tasks.md` MUST include:

   - Explicit **wiring** tasks per job kind / entry point → domain pipeline
   - One **product-loop acceptance** task (last implement task, before verify)

   Missing spine = plan **not** ready. (`forge phase done` refuses without a
   valid spine — keyword sniffing does not decide.)

5. Update session:
   ```bash
   forge phase plan --plan-type openspec --openspec <change-name>
   forge phase implement --tasks-total <N>
   ```
   Count tasks from `tasks.md` checkboxes.

6. Get user approval to proceed to implement (unless they already said "go").

## Session tracking

Forge session holds orchestration artefacts; canonical plan lives under
`openspec/changes/<name>/`.
