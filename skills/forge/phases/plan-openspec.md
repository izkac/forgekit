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
   write `openspec/changes/<change-name>/brief.html` — a plain-language,
   self-contained HTML explanation of what will be built (mermaid diagrams
   where helpful), then:

   ```bash
   forge brief stamp    # records specs hash (does NOT auto-open)
   ```

   `forge phase implement` hard-refuses while the brief is missing or stale
   (specs edited after stamping → rewrite affected sections and re-stamp).

6. Update session:
   ```bash
   forge phase plan --plan-type openspec --openspec <change-name>
   forge phase implement --tasks-total <N>
   ```
   Count tasks from `tasks.md` checkboxes.

7. Get user approval to proceed to implement (unless they already said "go").
   The brief is what the operator reviews — tell them its path and that
   `forge brief open` launches it; never open it for them.

## Session tracking

Forge session holds orchestration artefacts; canonical plan lives under
`openspec/changes/<name>/`.
