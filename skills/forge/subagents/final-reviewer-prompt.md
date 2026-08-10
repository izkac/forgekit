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

Session diff range: {DIFF_RANGE}   <!-- REQUIRED. `forge checkpoint --range` (no `--last`) → the whole session from `session.baseCommit`. No checkpoints: `git diff` against that base + the untracked files in `git status`. -->

Files changed in this session:

{CHANGED_FILES}

**The session diff is your scope.** Read it in full, plus every untracked file
listed with it. If the range is empty or unfilled, return `NEEDS_CONTEXT` rather
than reconstructing it by exploring the repository.

Your two required sections below — the spec-to-runtime trace and product-loop
acceptance — send you outside the diff on purpose: follow a capability to its
production caller, read `spine.json` and `e2e.json`, open the file a spine row
names. That is directed reading and the whole point of this review. Everything
else stays inside the diff: no directory sweeps, no grepping for related code,
no reading modules this session never touched to see how the project generally
works.

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

## Attribution (first line of your report)

Open with `Reviewer: <your model> (<this prompt's role>)` — e.g. `Reviewer: claude-opus-5 (task-reviewer)`. The coordinator saves your report verbatim and `forge score` reads it, so this line is how a dispatched review is told apart from one the coordinator wrote. Do not write it if you are not a dispatched reviewer.

Write this line as if it decides. When the coordinator dispatched you with the description exactly `forge-review final <session-id>` — what `forge review-label final` prints — the host recorded it and `forge score` reads that record instead of your prose. Printing that label also wrote a dispatch stamp (`reviews/dispatches.json`, in the session's own directory, not the host's) — it records that a label was issued (unit, session, time, resolved model) and it survives pruning that would erase the host's own record. It does not record that a reviewer ran, which is why it ranks below the host's own record and is not a guaranteed stand-in for it: a stopped or below-substance dispatch whose transcript is later pruned can grade `recorded`/independent off the stamp where an intact host record would have said `self` — over-credit is this mechanism's disclosed error direction, not a promise the stamp matches what the host would have shown. Otherwise your wording usually decides — **but not always**: if this session labelled its *group* reviewers and not you, no `final` stamp exists either, Forge reads the missing `final` record as "no outside reader", your words are never consulted, and `forge phase done` refuses a high-risk change. Your wording decides only in the true no-record case — no host answer for `final` and no dispatch stamp for it. If you can see that has happened, say so in your report; it is a real finding about the session, not a detail.

Only your opening lines and this attribution are scanned, so discuss the coordinator's self-checks freely in the body — that is your job. Just keep `self-check` / `self-audit` / `self-review` / `self-authored` out of this line and out of your opening two paragraphs, where they mark the report as the author's own. If you quote another review's `Reviewer:` header, put it in a fenced block or a `>` blockquote — an unquoted copy of someone else's attribution reads as yours.

## Verdict

- **READY** — every capability has a runtime owner, product loop evidenced, tests evidence real outcomes, no critical gaps
- **NOT READY** — list blockers (prefer runtime-integrity and missing wiring first)

Do not approve if tests were not run, **`test-evidence.md` is missing**, tasks remain unchecked, or any claimed capability is library-only / stubbed / false-succeeding. Task checkboxes at 100% do **not** override a broken spine.
