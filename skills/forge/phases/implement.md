# Implement phase

**Enter the phase by declaring the plan's size — before the first dispatch:**

```bash
forge phase implement --tasks-total <N>   # N = checkbox count in tasks.md
```

Pace and **ceremony** resolve from this transition. A session that never
declares stays on the full tail even when it qualifies for the combined close
(ceremony fails closed to `full` at the done gate) — two cohort-5 trials paid
the full ceremony on small changes for exactly this omission.

Read and follow [../skills/subagent-driven-development/SKILL.md](../skills/subagent-driven-development/SKILL.md).

Every implementer subagent must follow [../references/tdd-core.md](../references/tdd-core.md) (condensed TDD rules — the brief includes the pointer; full skill only when stuck).

On test failures or unexpected behavior, use [../skills/systematic-debugging/SKILL.md](../skills/systematic-debugging/SKILL.md) before proposing fixes.

**Test strategy:** [../references/test-strategy.md](../references/test-strategy.md) — tier 1 (scoped TDD) + tier 2 (narrow task evidence) during implement; **tier 3 (full workspace) runs once at verify**, not per task.

**Pace:** Read `resolvedPace` / effective knobs from `forge status` (or [../references/pace.md](../references/pace.md)). After each **work unit** (below), decide whether to dispatch a reviewer via `review.perTask` + hard floor:

| `review.perTask` | When to dispatch reviewer |
| ---------------- | ------------------------- |
| `always` | After every unit (`thorough`) |
| `per-group` | When the unit closes a `tasks.md` group (`##` section — OpenSpec or specs engine), or immediately if any task in it is high-risk (`standard`) |
| `high-risk-only` / `never` | Only when hard-floor high-risk |

A high-risk task is its own unit and gets its own reviewer, on every pace — that
floor is what lets the rest of a change ride in larger, cheaper units.

**Review labels — the rules; the reasoning is in [../references/review-labels.md](../references/review-labels.md).**

- The **final** reviewer is dispatched from [review.md](./review.md), with the
  description **exactly** what `forge review-label final` prints — nothing before
  or after. **Run the command; never type the string.** The trailing session id is
  what makes the record yours, and a mistyped id matches nothing. That rule is
  repeated in both files because forgetting it is what refuses a change.
- **Label the final reviewer, or label nothing.** Group labels
  (`forge review-label <group-dir>`) are optional and feed no number — but once
  any dispatch of yours carries a label, a *missing* `final` label reads as "no
  outside reader" rather than "not adopted", the review file's wording is never
  consulted, and `forge phase done` refuses a high-risk change that genuinely had
  an independent reviewer. Partial adoption is worse than none, and it fails
  silently.

**Head every review file with who wrote it.** A dispatched reviewer names its
resolved model (`Reviewer: claude-opus-5 (task-reviewer)`); a review you wrote
yourself must declare it in one of the phrases `forge score` recognises, and the
list is **closed**: `self-check`, `self-review`, `self-audit`, `self-authored`,
`Reviewer: coordinator`, `reviewed by the coordinator`, `APPROVED (pace …)`,
`SKIPPED (pace …)`.
Describing it in your own words — *"I wrote this myself, no subagent ran"* —
scores as an outside reader you never had.

*Head* is literal: put the phrase in the **opening two paragraphs** (blank-line
separated, any length). Below that only a line beginning `Reviewer:` is reliably
read, and it still has to carry one of the phrases — `Reviewer: coordinator`
works anywhere in the file, `Reviewed by: coordinator` does not.

**For the files this phase writes — `task-review.md` and `group-review.md` — that
wording is not a fallback. It is the whole answer, always.** Host evidence is
scoped to the *final* review only, so a group review is classified from its words
even when the session has full host evidence including that group's own dispatch.
An unrecognised phrasing is scored as an outside reader you never had, and lands
permanently in `sessions.jsonl` and the fleet totals.

When skipping the reviewer, still write `task-review.md` with `Reviewer: coordinator — APPROVED (pace self-check)` and keep tier-2 evidence mandatory for behavior changes. For `per-group` reviews, cover all tasks in that section in one reviewer pass; save as `group-review.md` next to the group’s tasks (or under `.forge/sessions/<id>/tasks/group-<nn>-<slug>/group-review.md`). Prefer `--tier fast` when `models.bias` is `prefer-fast` and the task is mechanical. Cap fix→re-review loops at `review.maxRounds`.

## Plan source

| planType | Task list |
| -------- | --------- |
| `openspec` | `openspec/changes/<name>/tasks.md` via **`/forge:apply`** (preferred), **`openspec-apply-change`** / `/opsx:apply` |
| `specs` | `<specsDir>/changes/<name>/tasks.md` (default `specs/`) — read directly; no vendor CLI steps |

Legacy sessions with planType `throwaway` or `direct`: resume from the session's own artefacts (`plan.md` / `brainstorm/notes.md`); new work always uses the configured engine (`openspec` or `specs`).

For OpenSpec: follow `openspec-apply-change` for CLI steps, but **wrap each task** in the subagent loop (do not implement all tasks inline in coordinator context). For specs: read `proposal.md` / `design.md` / `tasks.md` from the change dir as context, then run the same subagent loop.

## Runtime integrity (hard)

Honor [../references/runtime-integrity.md](../references/runtime-integrity.md) in every brief and review packet:

- Briefs **must never** contain “stub OK”, “later task”, “minimal poll loop only”, or equivalent. Shrink scope only by stopping and asking the user.
- Capability specs beat narrow task wording. Fill reviewer `{CAPABILITY_SPEC_EXCERPT}` from the change's capability specs — not only the task line.
- Do not mark a section complete if libraries exist but nothing in the production path calls them.
- **Deferrals:** if wiring genuinely lands in a later task, register it — `forge defer add --task <id> --reason "…"` — and resolve it when that task lands. Unregistered "later" is a REJECT; unresolved deferrals block `forge phase done`.
- **Spine:** when a task wires a capability into production, update its `spine.json` row (runtimeOwner / writes / evidence). `forge spine check` must pass before verify ends.
- **E2E:** the product-loop acceptance task (last implement task) delivers working `e2e.json` steps and a green `forge e2e run` — steps that would pass against a stubbed handler are invalid.

## Briefs: mark what you measured, and never quote an expected value

A brief is read by a subagent with no chat history, so every sentence in it
lands as established fact. Two habits, both bought the hard way:

- **Tag each load-bearing claim `measured: <how>` or `assumed — verify`.** A
  brief once stated a data-format rule flatly, alongside genuinely measured
  facts, and the implementer had no way to tell which was which. It was an
  assumption, it was wrong, and it survived TDD, self-review and a corpus check
  because every fixture had been built from the brief's own premise. If you did
  not run the command, say so and say what would settle it.
- **State the rule and the fixture; never state the expected number.** The
  implementer derives expected values in code (see
  [../references/tdd-core.md](../references/tdd-core.md)). A quoted figure that
  is wrong produces an assertion that passes against buggy code and looks like
  coverage — three of them appeared in one change's briefs, two caught only
  because an implementer recomputed rather than trusting the brief.

Both apply to **reviewer** packets too: a reviewer told "the totals are 43" will
check for 43.

## Per-unit loop

**A work unit is one implementer dispatch, and by default it is one `tasks.md`
group** — see [Work units](../skills/subagent-driven-development/SKILL.md#work-units-what-one-implementer-dispatch-covers)
for when to split one (high-risk task, more than 4 tasks, a real dependency on a
review verdict, or nothing shared between them). Dispatching task-by-task pays
the subagent ramp-up once per task, and that ramp-up — not review verdicts — is
where Forge's input tokens go.

1. Extract full task text + file paths + relevant **capability** spec sections (not only the task checkbox line) for every task in the unit.
2. Write the unit's brief using [../subagents/implementer-prompt.md](../subagents/implementer-prompt.md) — `.forge/sessions/<id>/tasks/<nn>-<slug>/brief.md` for a single-task unit, `.forge/sessions/<id>/tasks/group-<nn>-<slug>/brief.md` for a multi-task one. Fill `{SESSION_ID}` with the current session id, `{TASK_LIST}` with one block per task (full text, in order, each naming its own task id), and `{TASK_IDS}` with those ids; never leave a target for the implementer to infer from `.forge/active.json`.
3. Dispatch **implementer** subagent — brief includes [../references/tdd-core.md](../references/tdd-core.md). **Model:** follow [../references/model-selection.md](../references/model-selection.md) — resolve via `forge resolve-model --tier <fast|standard|capable>` (billing defaults to **`included`**). Use `fast` when the whole unit is mechanical (1–2 files, complete spec); `standard` for multi-file integration; escalate one capability tier (still `included`) when re-dispatching after `BLOCKED`. Judge the tier from the unit, not from its easiest task. If `omitModel` is true, **omit** the Task `model` parameter entirely (never pass a host-list slug); otherwise pass `model` exactly.
4. **Reviewer** (unless pace skips it):
   - **`always` / high-risk hard floor:** dispatch [../subagents/task-reviewer-prompt.md](../subagents/task-reviewer-prompt.md) for this unit → `task-review.md` (one pass covering every task in it; `group-review.md` if the unit is a whole group).
   - **`per-group` at group boundary:** dispatch one reviewer covering **all tasks in the just-finished `tasks.md` group** → `group-review.md` (include each task id + paths). Mid-group low-risk units: self-check `task-review.md` only.
   - `{DIFF_RANGE}` is **required** — the reviewer returns `NEEDS_CONTEXT` without it and you pay for the dispatch twice. Get it from `forge checkpoint --range --last` (`reviewTarget`), which also names the untracked files a diff hides.
   - If `review.depth` is `spec-only`, focus on spec + tests evidence. Fill `{TASK_EVIDENCE_TARGETS}` with one entry per reviewed task (task id, executed-evidence gate state, and exact session/task ledger path), plus `{DIFF_RANGE}`, `{CAPABILITY_SPEC_EXCERPT}`, and `{GUARD_ALLOWANCES}` (paste `.forge/sessions/<id>/guard-allowances.json`'s contents — there is no `forge guard list` to generate this — or "none" if the file doesn't exist) — read actual code, not the implementer's summary. **Model:** [../references/model-selection.md](../references/model-selection.md) — `forge resolve-model --tier standard` (or `capable` for money/auth/contracts; use `fast` when `models.bias` is `prefer-fast` and not high-risk). Honor `omitModel` / `model` literally. Do **not** skip high-risk tasks.
5. Fix loop until the reviewer approves (max `review.maxRounds` from pace; then escalate to the human). For group reviews, fix any rejected task in the group before continuing to the next group.
6. **Tier-2 evidence — two paths, know which one this task takes:**
   - **Behavior-change tasks (TDD applies):** evidence comes from
     `forge tdd run --session <id> --task <task-id>` stamps the implementer
     produced during the loop — a red stamp (`--expect fail`) before production
     code, a green stamp (`--expect pass`) after (see
     [../references/tdd-core.md](../references/tdd-core.md)). Each call executes
     the command itself and appends to
     `.forge/sessions/<id>/tasks/<task-id>/tdd-runs.jsonl`; there is nothing for the coordinator to
     stamp by hand here — do **not** also run `forge evidence` for the same
     command; `forge score` reads the stamps directly (an ok pass-stamp counts
     as tier-2 coverage even with no `test-evidence.md`), so this costs
     nothing on the scorecard. For sessions carrying `features.tddEvidence`,
     `forge phase done|finish` refuses a completed task with no fail-stamp
     chronologically before a pass-stamp in that file.
   - **Non-TDD artifacts (docs-only, config, other work with no red/green
     cycle):** do **not** just run the plain evidence command — declare it, so
     the pairing gate knows this task has no red→green cycle to demand:
     ```bash
     forge evidence --task <nn>-<slug> --no-tdd --reason "<why no test cycle applies>"
     # or, with a command that still ran (e.g. a lint pass):
     forge evidence --task <nn>-<slug> --command "<cmd>" --exit 0 --summary "<pass summary>" --no-tdd --reason "<why>"
     ```
     `--no-tdd` writes a durable, reviewer-visible marker that exempts the
     task from the pairing gate; evidence recorded without it does **not**
     exempt anything. A completed task with neither a red→green stamp pair
     nor a `--no-tdd` declaration refuses at `forge phase done`, with no way
     through except producing one of the two. (Template + rules in
     [../references/test-evidence.md](../references/test-evidence.md).)

   **Add `--session <id>` to either command when more than one session is open
   in the project.** Without it the session comes from `.forge/active.json`,
   which is a hint — and both commands write into `sessions/<id>/tasks/<task>/`,
   where `forge score` reads them into that session's scorecard and durable
   ledger. `forge evidence` refuses rather than replace evidence a previous run
   produced, so a wrong guess costs you a re-run rather than somebody else's
   record; naming the session removes the refusal for later runs of the same
   task.

   If an implementer's edit is denied by the test-tamper guard mid-task, see
   **Guarded files** below before re-dispatching.
7. Mark every task the unit finished complete in `tasks.md` (`- [ ]` → `- [x]`) — tick them from the implementer's per-task report, not from its overall status; a unit that stopped part way leaves the rest unticked. That checklist is the source of truth — fleet/status/health derive `tasksComplete` from it (and heal the session cache). Still run the progress command below when you want `--subagents` updated. Detect group boundary: next line in `tasks.md` is a new `##` heading, or no remaining tasks under the current heading.
8. **Checkpoint** — when the project opts in (`.forge/config.json` → `git.checkpoint`):
   ```bash
   forge checkpoint --group <nn>-<slug> --tasks <ids>   # per-group: at the boundary; per-task: after each task
   ```
   Commits the group's work and records the sha on the session. Never pushes,
   refuses on the default branch, and leaves `.forge/` scratch out of the
   commit. Default is `off`: nothing is committed and reviewers read the
   working tree, as before.

   **Reviewer scope (step 4).** The group review runs *before* this
   checkpoint, so fill `{DIFF_RANGE}` from `forge checkpoint --range --last` →
   its **`reviewTarget`** field. While the group is uncommitted that is
   `git diff <last checkpoint>` plus the untracked files named explicitly (a
   diff never shows them); once checkpointed it collapses to a plain commit
   range. Do **not** paste `range` during a pre-checkpoint review — it is
   empty until the group lands. Without checkpoints, every reviewer after task
   1 re-reads all previous tasks' diffs.
9. Repeat.

**Unit sizing:** the rules live in [subagent-driven-development](../skills/subagent-driven-development/SKILL.md#work-units-what-one-implementer-dispatch-covers). One group per dispatch by default; at most 4 tasks; split when a later task needs an earlier one's *review* verdict or when the tasks share no files or spec. **Never put a money/auth/contract/migration task in a multi-task unit** — those keep 1:1 dispatch with their own review, whatever the pace says.

```bash
forge phase implement --tasks-complete <N> --subagents <total dispatched so far>
```

## Guarded files

A test file that already existed at the session's `baseCommit` (matching
`guard.testGlobs`), plus Forge's own integrity artifacts (`spine.json`,
`e2e.json`, `e2e-results.json`, `verify-evidence.md`, `openspec-verify.md`,
`test-evidence.md`, `tdd-runs.jsonl`), is **guarded** against tool-call edits: a
`PreToolUse` hook on `Edit`/`Write`/`NotebookEdit`/`MultiEdit` denies implementer
edits to it
during implement/verify/review/finish. Tests an implementer writes fresh
during this session are not guarded — TDD still works. `verify-evidence.md`
and `openspec-verify.md` are the exception to the implement-onward window:
they are authored during verify itself (see [verify.md](./verify.md)), so they
stay editable through implement and verify and freeze starting review.

Forge's own control surface is guarded too, unconditionally, regardless of
`guard.testGlobs` or tracking state: `.forge/config.json`, `.forge/active.json`,
and any session's `session.json`. These are what the guard itself reads to
decide what to guard and which session to guard against — an implementer (or
an agent routing around a denied edit) cannot turn the guard off by rewriting
its configuration or its trust anchors instead of the file it was told not to
touch.

`guard.testGlobs` in `.forge/config.json` overrides the default glob set
(`**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`, `**/test/**`,
`**/tests/**`) — a project override **replaces** the defaults, it does not
add to them, so `{ "guard": { "testGlobs": ["tests/**"] } }` silently drops
guard coverage for `*.test.*` files living outside `tests/`. Read the
project's `.forge/config.json` before assuming the default globs apply. An
override that resolves to zero usable globs (`[]`, or all-blank strings) is
treated as a configuration error, not an opt-out — the guard falls back to
the defaults and warns loudly rather than silently guarding nothing; a
genuine opt-out has to be an explicit, reviewable glob list.

The hook's session resolution does not trust `.forge/active.json` alone: with
no explicit `--session`, it considers every unfinished session in the
enforcement window and denies if **any** of them guards the file, even when
the pointer currently names a different (non-guarding, or out-of-window)
session. A second concurrent session — including a throwaway one created by
`forge new` — cannot turn the guard off for the session actually doing the
work.

- **Implementers must never run `forge test-allow`.** A denied edit is not an
  obstacle to route around; it means the task, as briefed, requires changing a
  file that isn't the implementer's to change. **The hook only intercepts tool
  calls** (`Edit`/`Write`/`NotebookEdit`/`MultiEdit`) — a shell `rm`, `sed -i`,
  or `>` redirect against a guarded file is not intercepted and must never be
  used to route around a deny either; the rule is about the file, not the tool.
- A denied edit comes back as `NEEDS_CONTEXT` or `BLOCKED` with the guard's
  deny message verbatim — read it before re-dispatching; it names the file and
  the escape hatch.
- Only the **coordinator** decides whether the change is legitimate (a test
  genuinely needs to change alongside a contract) and records the allowance
  with a reason:
  ```bash
  forge test-allow <path> --reason "<why this edit is legitimate>"
  ```
  That reason is not private — it lands at
  `.forge/sessions/<id>/guard-allowances.json` and in the reviewer's packet
  (there is no `forge guard list`; paste the ledger file's contents into
  `{GUARD_ALLOWANCES}` yourself), and a weak reason is a review finding (see
  [../subagents/task-reviewer-prompt.md](../subagents/task-reviewer-prompt.md)).
- **The integrity backstop's coverage is narrower than the hook's.**
  `forge integrity-check` / `forge phase done|finish` re-check guarded files
  from `git diff`, which only ever sees **tracked** files — so the backstop
  catches a guarded test (tracked at `baseCommit`) and a committed
  change-dir artifact (e.g. `openspec/changes/<name>/spine.json`), and a
  tracked `.forge/config.json`, on every host, hooked or not, but **not** an
  integrity artifact living only under the gitignored `.forge/sessions/<id>/`
  (including that session's own `session.json` and `.forge/active.json`),
  which no diff can see. The hook is the real defense for session-dir
  artifacts and for `session.json`/`active.json` specifically; the backstop
  is a second line for what git can see.

## Forge constraints (include in every brief)

- **No** autonomous `git commit` or `git push` — implementer subagents never commit. Checkpoints are the coordinator's job and only when `git.checkpoint` is enabled (`forge checkpoint`, which still never pushes)
- **Tier 2 tests only** before claiming task done — narrowest command for this task ([test-strategy.md](../references/test-strategy.md)); **not** the full workspace suite unless the task requires it
- Trace ecosystem consumers when contracts change
- Minimal diff — surgical changes only
- Runtime integrity: no stubs / false success; name the runtime caller; tests must fail on a no-op ([runtime-integrity.md](../references/runtime-integrity.md))

## After all tasks

Proceed to [verify.md](./verify.md) then [review.md](./review.md).
