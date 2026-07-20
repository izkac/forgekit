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

## 5. E2E means an executed product loop, not prose

Before claiming the change complete:

1. Author the **closed product loop** as executable steps in `e2e.json`
   (`forge e2e init`), run it against the live entry points
   (`forge e2e run`), and get a **green run** — **or**
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

The mechanical gate requires a green, **current** `e2e-results.json` (its
steps hash must match `e2e.json`) whenever the spine has real rows.
Describing the loop in `verify-evidence.md` no longer satisfies the gate —
prose cannot prove wiring. Each step is `{ name, cmd, expect?, timeoutMs? }`:
exit code 0 required, `expect` (regex) matched against the output. Steps must
assert **domain side effects** — a step list that would pass against a
stubbed handler is invalid (rule 3 applies to e2e steps too).

`e2e.json` may set `"notApplicable": "<reason>"` only when the loop cannot be
driven by any command (e.g. requires a physical device). Reviewers police the
reason; "no time" or "covered by unit tests" is a REJECT. Keep a short loop
narrative under `## Product loop` in `verify-evidence.md` as reviewer context.

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

**Spine is mandatory for every Forge change** — not gated on pace, and not
inferred from slug keywords (that miss is how hollow platforms shipped).

At plan time (every change):

```bash
forge spine init
```

Then either:

1. **Fill rows** — one per capability/REQ cluster:

   | capability | library | runtimeOwner | writes | reads | uiConsumer | evidence |

   Every cell filled (`reads` / `uiConsumer` may be `"N/A"`); `evidence` points
   at the tier-2/E2E proof of the **wired** path. Library-only rows fail
   `forge spine check` — and `forge phase done` runs the same check.

2. **Or** set `"notApplicable": "<reason>"` for sync-only / docs-only work
   (e.g. `"sync HTTP only — no async producer/consumer"`). That is the honest
   opt-out; missing `spine.json` is not.

An executed product loop (`forge e2e run`, green + current results) is
required when the spine has real rows. Prefer `notApplicable` for sync-only
changes instead of inventing a fake loop.

## Reviewer REJECT checklist (mandatory)

REJECT the task (or final review → `NOT READY`) if any of:

- Success path has no domain side effects required by the capability
- Tests would pass with a no-op handler
- API / UI can enqueue or trigger a kind the runtime cannot truly execute
- UI / consumers depend on data nothing in the production path writes
- Spec requirement has a library but no named runtime owner
- Deferred wiring without a registered open deferral (`forge defer list`)
- Spine row for this capability missing or library-only
- E2E steps would pass against a stubbed handler (no domain side-effect
  assertions), or `e2e.json` opts out via `notApplicable` without a real reason

## Plan seam (every change)

Before apply-ready:

1. `forge spine init` — **always**. Fill rows for each capability, or set
   `notApplicable` with a reason (sync-only / docs-only).
2. When the spine has real rows, `forge e2e init` — the acceptance **steps are
   a plan deliverable**: author (or task out) the `e2e.json` step list that
   drives the loop and asserts its side effects.
3. If the change involves workers, job queues, handlers, or cross-runtime
   calls, `tasks.md` MUST also include:
   - Explicit **wiring** tasks per job kind / entry point → domain pipeline
   - One **product-loop acceptance** task (last implement task, before
     verify) — its output is a green `forge e2e run`

Missing spine = plan not ready. Keyword guesses about “jobs in scope” are not
an excuse to skip the spine.
