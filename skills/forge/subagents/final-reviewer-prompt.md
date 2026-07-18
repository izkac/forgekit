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
job, …) that invokes the implementing code.

- Library-only / no production caller → **`NOT READY`**
- Stub handler / false success / enqueueable-but-unhandled kind → **`NOT READY`**
- Missing E2E fixture path with no explicit `BLOCKED` in `verify-evidence.md` → **`NOT READY`**

## Verdict

- **READY** — every capability has a runtime owner, tests evidence real outcomes, no critical gaps
- **NOT READY** — list blockers (prefer runtime-integrity and missing wiring first)

Do not approve if tests were not run, **`test-evidence.md` is missing**, tasks remain unchecked, or any claimed capability is library-only / stubbed / false-succeeding.
