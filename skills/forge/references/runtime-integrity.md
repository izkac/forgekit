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

## 5. E2E means product loop, not job slice

Before claiming the change complete:

1. Run (or document exact commands for) the **closed product loop** through the
   live entry points, **or**
2. Leave an explicit **`BLOCKED`** list in `verify-evidence.md` — and do **not**
   mark the change complete / advance to `done`.

**A single job slice is not platform E2E.** When the design has a
producer/consumer split (analyze vs execute, proposals vs ratify, write vs
read), the required E2E is the full loop:

```
produce artifact → consumer reads it → decision/state change →
next run's OUTPUT DIFFERS from the baseline
```

Example: ingest→Parquet plus a thin run→`.sav` does **not** verify a
governance loop; analyze→proposals→ratify→run-applies-decisions does.
Record it under a `## Product loop` heading in `verify-evidence.md` —
the mechanical gate looks for it.

## 6. Job-kind closure

Every job kind / entry point on the product surface (enums, API, UI) is, before
the change can be complete, exactly one of:

- **Wired end-to-end** (enqueueable + handled + domain side effects), or
- **Deleted** from the enums / API / UI surface.

“Fail closed for unsupported kind” is only a **temporary BLOCKED state**, never
“change complete.” Schema fiction (kinds nobody handles or enqueues) is a
verify failure.

## 7. Consumer–producer rule

If a UI page, API response, or downstream job **reads** a collection, artifact,
or field, verify must prove something in the **production path writes it**
(fixture evidence), or the change is BLOCKED. Empty-forever queues that only
tests can fill are a REJECT.

## 8. Deferrals are tracked debt, never checkboxes

“Wiring in a later task/section” is only acceptable when registered:

```bash
forge defer add --task <id> --reason "wiring lands in task <id>"
forge defer resolve --task <id>     # when the wiring task actually lands
```

- Reviewers may only accept a deferral that names a **registered, still-open**
  task (`forge defer list`).
- `forge phase done|finish` **refuses** while any deferral is unresolved.
- An unregistered "later" in a brief or review is a REJECT.

## Spine matrix (mechanical — `forge spine`)

For any change involving workers, jobs, queues, handlers, or cross-runtime
calls, maintain `spine.json` in the change dir (`forge spine init`): one row
per capability/REQ cluster —

| capability | library | runtimeOwner | writes | reads | uiConsumer | evidence |

- Every cell filled (`reads` / `uiConsumer` may be `"N/A"`); `evidence` points
  at the tier-2/E2E proof of the **wired** path.
- Library-only rows (missing runtimeOwner / writes / evidence) fail
  `forge spine check` — and `forge phase done` runs the same check.
- Changes genuinely without a runtime seam set `"notApplicable": "<reason>"`.

## Reviewer REJECT checklist (mandatory)

REJECT the task (or final review → `NOT READY`) if any of:

- Success path has no domain side effects required by the capability
- Tests would pass with a no-op handler
- API / UI can enqueue or trigger a kind the runtime cannot truly execute
- UI / consumers depend on data nothing in the production path writes
- Spec requirement has a library but no named runtime owner
- Deferred wiring without a registered open deferral (`forge defer list`)
- Spine row for this capability missing or library-only

## Plan seam (workers / jobs / cross-runtime)

If the change involves workers, job queues, handlers, or cross-runtime calls,
before apply-ready:

1. `tasks.md` includes explicit **wiring** tasks per job kind / entry point →
   domain pipeline
2. `tasks.md` includes one **product-loop acceptance** task (last implement
   task, before verify)
3. `forge spine init` — scaffold the spine matrix and fill known rows

Missing seam = plan not ready.
