# Runtime integrity (hard rules)

Forge verifies **outcomes of the system**, not only artifacts of work. These
rules apply at every pace. Coordinators, implementers, and reviewers must not
weaken them in briefs.

## 1. No stubs / no false success

A handler that only logs, bumps progress, or marks a job/request `succeeded`
without doing the domain work is **forbidden**.

- If a job kind (or API path) is enqueueable / callable in production, it MUST
  run real domain logic, **or** fail closed with a clear error, **or** not be
  exposed at all.
- Never authorize “stub OK”, “minimal poll loop only”, or “wire later” for a
  path this change claims.

## 2. Runtime owner required

A capability requirement is **not** met by a library module alone.

- For every REQ / capability this change implements, name the **production
  caller** (worker job kind, HTTP endpoint, CLI command, scheduled job, …).
- Library-only = incomplete. Add a wiring task before marking the section done.

## 3. Tests must fail on a no-op

Evidence that only asserts ceremony is invalid.

| Invalid | Valid |
| ------- | ----- |
| Job status became `succeeded` | Fixture upload/run left the expected domain side effects |
| Handler was called | Mongo/files/artifacts match the capability (or structured failure) |
| Queue claim/lease works | Pairing/stats/proposals/exports exist as specified |

If a test suite would still pass with a no-op handler, it does not prove the
task.

## 4. Briefs may not narrow scope

**Capability specs beat narrow task wording** when they conflict.

- Coordinator briefs MUST NOT redefine done downward (e.g. authorize a stub
  when the spec requires real ETL).
- To shrink scope: stop and ask the user. Do not silently checkbox around gaps.
- Prefer `DONE_WITH_CONCERNS` / incomplete tasks over green checkboxes.

## 5. E2E-or-BLOCKED

Before claiming the change complete:

1. Run (or document exact commands for) **one real fixture path** through the
   live entry point for each critical production path this change owns, **or**
2. Leave an explicit **`BLOCKED`** list in `verify-evidence.md` — and do **not**
   mark the change complete / advance to `done`.

Never checkbox around a missing end-to-end path.

## Reviewer REJECT checklist (mandatory)

REJECT the task (or final review → `NOT READY`) if any of:

- Success path has no domain side effects required by the capability
- Tests would pass with a no-op handler
- API / UI can enqueue or trigger a kind the runtime cannot truly execute
- UI / consumers depend on data nothing in the production path writes
- Spec requirement has a library but no named runtime owner

## Plan seam (workers / jobs / cross-runtime)

If the change involves workers, job queues, handlers, or cross-runtime calls,
`tasks.md` MUST include before apply-ready:

1. Explicit **wiring** tasks per job kind / entry point → domain pipeline
2. One **E2E fixture** acceptance task

Missing seam = plan not ready.
