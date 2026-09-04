# Final implementation reviewer

Review the **entire** Forge session implementation against the plan **and**
the capability specs. See [references/runtime-integrity.md](../references/runtime-integrity.md).

## Plan source

{PLAN_REFERENCE}

## Capability specs (source of truth)

{CAPABILITY_SPECS_REFERENCE}

## Tasks completed

{TASK_SUMMARY}

## Precheck (machine-verified — do not re-run)

{PRECHECK}   <!-- REQUIRED. Unfilled or still `{PRECHECK}` → return `NEEDS_CONTEXT`; nothing below substitutes for it. Paste `forge review-precheck` output verbatim. It carries integrity status, per-task red→green pairing, guard allowances, changed files, recorded reviews, and your review mode. -->

Everything in that block was computed by `forge` from the ledgers and git, and
the verify phase has already run tier 3. **Do not re-run test suites, `forge
spine|e2e|defer|integrity-check`, or ledger inspection** — re-running them
finds nothing the block does not already say and is most of what a final review
used to cost. Read it; judge the *reasons* (allowances, no-TDD declarations);
treat a `FAIL`/`PROBLEMS` line as a finding.

## Scope and mode

Session diff range: {DIFF_RANGE}   <!-- REQUIRED. `forge checkpoint --range` (no `--last`) → the whole session from `session.baseCommit`. No checkpoints: `git diff` against that base + the untracked files in `git status`. The precheck above lists the changed files. -->

If the range is empty or unfilled, return `NEEDS_CONTEXT` rather than
reconstructing it by exploring the repository.

The precheck names your mode:

- **integration** — the units the precheck marks *independent* were already
  read by an outside reviewer. **Do not re-review those hunks.** Units marked
  self-check, and any unit the precheck lists as carrying a REJECTED verdict,
  are yours to read in full. Then read the diff for what a per-group reader
  cannot see: the seams (files touched by more than one
  group, a contract one group changed and another consumes), the spec-to-runtime
  trace, and the product loop. Re-open a hunk only when a seam or a spec
  requirement sends you there.
- **full-diff** — no dispatched reviewer has read the code (brisk/lite
  self-checks only). You are the first outside reader: read the whole diff plus
  every untracked file listed, then do the two required sections below.

In both modes the required sections send you outside the diff on purpose:
follow a capability to its production caller, read `spine.json` and `e2e.json`,
open the file a spine row names. That is directed reading. Everything else
stays inside the diff: no directory sweeps, no grepping for related code, no
reading modules this session never touched to see how the project generally
works. If `.forge/sessions/<id>/spec-verify.md` (specs) or
`openspec-verify.md` (OpenSpec) exists, read the Forge disposition.

## Spec-to-runtime trace (required)

For **each** requirement in the change's capability specs, name the
**production caller** (worker job kind, HTTP endpoint, CLI command, scheduled
job, …) that invokes the implementing code. Cross-check against the spine rows
— every capability row must be wired, not library-only.

- Library-only / no production caller → **`NOT READY`**
- Stub handler / false success / enqueueable-but-unhandled kind → **`NOT READY`**
- Job kind on the product surface that is neither wired end-to-end nor deleted → **`NOT READY`**
- UI/API reads a collection or artifact nothing in the production path writes → **`NOT READY`**
- Missing E2E fixture path with no explicit `BLOCKED` **and** no recorded project/session skip → **`NOT READY`**

## Product-loop acceptance (required — executed, skipped, or blocked)

The precheck's integrity line already says whether `e2e.json` has a green,
current run or a recorded skip. Your job is the part no command can do: read
the steps. Would they pass against a stubbed handler? If yes, they prove
nothing. When the precheck shows a weak recorded RED for the task that wrote
the loop, one targeted mutation (neuter the handler, run the loop, restore) is
worth its cost; a full re-run of green suites is not.

- No green, current e2e run, no recorded skip, and no `BLOCKED` in `verify-evidence.md` → **`NOT READY`**
- E2E steps assert no domain side effects (would pass on a stub) → **`NOT READY`**
- `e2e.json` `notApplicable` without a reason no command could overcome → **`NOT READY`**
- Recorded skip (project or session) with a reason → **not** `NOT READY` for missing E2E
- `BLOCKED` present while the loop is still required (not skipped, not green) → **`NOT READY`** (honest, but not READY)
- Unresolved deferrals (precheck integrity line) → **`NOT READY`**

## Attribution (first line of your report)

Open with `Reviewer: <your model> (final reviewer)` — only if you are a dispatched reviewer; a coordinator writing this file declares itself instead (phases/review.md). The coordinator saves your
report verbatim and `forge score` reads that line. Keep `self-check` /
`self-review` / `self-audit` / `self-authored` out of your opening two
paragraphs — they mark a report as the coordinator's own. Quote another
review's `Reviewer:` header only inside a fenced block or `>` blockquote. The
reasoning behind labels and stamps is in
[references/review-labels.md](../references/review-labels.md); you do not need
it to review.

## Verdict

- **READY** — every capability has a runtime owner, product loop evidenced, tests evidence real outcomes, no critical gaps
- **NOT READY** — list blockers (prefer runtime-integrity and missing wiring first)

Do not approve if the precheck shows integrity problems, a task with failed or
missing evidence, tasks remain unchecked, or any claimed capability is
library-only / stubbed / false-succeeding. Task checkboxes at 100% do **not**
override a broken spine.
