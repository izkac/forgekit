# Final implementation reviewer

Review the **entire** Forge session implementation against the plan **and**
the capability specs. See [references/runtime-integrity.md](../references/runtime-integrity.md).

## Plan source

{PLAN_REFERENCE}

## Capability specs (source of truth)

{CAPABILITY_SPECS_REFERENCE}

## Tasks completed

{TASK_SUMMARY}

## Scope

All files changed in this session (use git diff or explicit list):

{CHANGED_FILES}

## Spec-to-runtime trace (required)

For **each** requirement in the change's capability specs, name the
**production caller** (worker job kind, HTTP endpoint, CLI command, scheduled
job, …) that invokes the implementing code. Cross-check against `spine.json`
(`forge spine check`) — every capability row must be wired, not library-only.

- Library-only / no production caller → **`NOT READY`**
- Stub handler / false success / enqueueable-but-unhandled kind → **`NOT READY`**
- Job kind on the product surface that is neither wired end-to-end nor deleted → **`NOT READY`**
- UI/API reads a collection or artifact nothing in the production path writes → **`NOT READY`**
- Missing E2E fixture path with no explicit `BLOCKED` in `verify-evidence.md` → **`NOT READY`**

## Product-loop acceptance (required — executed, not described)

`forge e2e check` must be green: `e2e.json` steps drive the **closed loop**
(produce → consume → decision changes output) and `e2e-results.json` records a
green, current run (steps hash matches). A single job slice (e.g. ingest→file)
or a library-level E2E does **not** count as platform E2E. Read the steps —
would they pass against a stubbed handler? If yes, they prove nothing.

- No green, current e2e run and no `BLOCKED` in `verify-evidence.md` → **`NOT READY`**
- E2E steps assert no domain side effects (would pass on a stub) → **`NOT READY`**
- `e2e.json` `notApplicable` without a reason no command could overcome → **`NOT READY`**
- `BLOCKED` present → **`NOT READY`** (honest, but not READY)
- Unresolved deferrals in `forge defer list` → **`NOT READY`**

## Verdict

- **READY** — every capability has a runtime owner, product loop evidenced, tests evidence real outcomes, no critical gaps
- **NOT READY** — list blockers (prefer runtime-integrity and missing wiring first)

Do not approve if tests were not run, **`test-evidence.md` is missing**, tasks remain unchecked, or any claimed capability is library-only / stubbed / false-succeeding. Task checkboxes at 100% do **not** override a broken spine.
