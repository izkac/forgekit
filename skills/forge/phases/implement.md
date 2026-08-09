# Implement phase

Read and follow [../skills/subagent-driven-development/SKILL.md](../skills/subagent-driven-development/SKILL.md).

Every implementer subagent must follow [../references/tdd-core.md](../references/tdd-core.md) (condensed TDD rules — the brief includes the pointer; full skill only when stuck).

On test failures or unexpected behavior, use [../skills/systematic-debugging/SKILL.md](../skills/systematic-debugging/SKILL.md) before proposing fixes.

**Test strategy:** [../references/test-strategy.md](../references/test-strategy.md) — tier 1 (scoped TDD) + tier 2 (narrow task evidence) during implement; **tier 3 (full workspace) runs once at verify**, not per task.

**Pace:** Read `resolvedPace` / effective knobs from `forge status` (or [../references/pace.md](../references/pace.md)). After each task, decide whether to dispatch a reviewer via `review.perTask` + hard floor:

| `review.perTask` | When to dispatch reviewer |
| ---------------- | ------------------------- |
| `always` | After every task (`thorough`) |
| `per-group` | When the task closes a `tasks.md` group (`##` section — OpenSpec or specs engine), or immediately if the task is high-risk (`standard`) |
| `high-risk-only` / `never` | Only when hard-floor high-risk |

**Dispatch the final reviewer with the description `forge review-label final`
prints** — exactly that, nothing before or after. Run the command; do not type
the string. That dispatch happens in [review.md](./review.md), not here; the
rule is repeated in both files because forgetting it is what refuses a change. A
group reviewer may carry `forge review-label <group-dir>`, but that is optional
and feeds no number; see the end of this section before you decide to use it.
The host records the description against the subagent it actually ran, and
`forge phase done` reads that record rather than the **final** review file's
wording. Running the command also writes a **dispatch stamp** —
`.forge/sessions/<id>/reviews/dispatches.json`, unit, label, session id,
timestamp, the reviewer model it resolved in-process (`--tier` overrides the
default `capable`) — and reports the stamp path and model on stderr. That
stamp lives in the session's own directory rather than the host's transcript,
so it outlives host-transcript pruning that erases the host's own record: a
reviewer stamped at dispatch time is no longer lost the day its host
conversation ages out, and `forge score` reads the stamp back as the
`recorded` grade wherever the host itself cannot answer. It is not a second
source of the same evidence — it proves a label was *issued*, not that a
review *ran* — so it never outranks the host's own record, only stands in
where the host has none.

The label carries the **session id**, and that is the load-bearing part. Without
it the join was "a review dispatch somewhere in this conversation while this
session was open" — and one Claude Code conversation routinely hosts several
Forge sessions, so a neighbour's reviewer was indistinguishable from yours.
Three review rounds each found a fresh way for that to pass a self-written
review through the money/auth floor. A dispatch still described in the old
two-word form is not counted for anyone: Forge reports that it cannot tell, and
falls back to the review file's wording. No amount of prose in a review file
produces that record; a subagent has to really run.

An earlier version of this paragraph called it the one field here you cannot
fabricate. That was too strong, and this project has the proof: it records a
*dispatch*, not a *review*, and dispatching is cheap — a throwaway subagent
carrying the label produced the same record, and it carried a change through the
money/auth gate against a review file that said in plain words no subagent had
read it. Forge now asks what the dispatch did: a unit whose busiest single
dispatch you did not stop made fewer than five requests certifies nothing, and
the wording decides instead. That ends the one-line forgery and nothing more —
someone who knows the floor can pad past it. The dispatch stamp above does not
reopen it either: a below-floor dispatch is the host having *measured* thin
work, not an absent record, and the stamp only ever substitutes for a record
the host lost, never for work a reviewer didn't do. Still a check on the
honest, not a defence against the deliberate.

The match is **exact** for a reason. `forge-review implement group 1` and
`talk about forge-review implementation details` both matched an earlier, looser
rule, so an implementer dispatch and a sentence of prose each manufactured
evidence of a review that never happened. This is also why the command exists:
a hand-typed label is a silent miss, and a silent miss at this gate refuses
correct work.

**Labelling a group reviewer arms a rule.** An earlier version of this paragraph
claimed a mislabelled dispatch "falls back to the file's wording — the safe
direction".
That is only true while **no** dispatch of yours carries a label. The moment one
does — and labelling your group reviews is exactly that — Forge treats the
convention as in use for this session, so a missing `final` label reads as
*"no outside reader"* rather than *"not adopted"*, the wording is not consulted,
and `forge phase done` refuses a high-risk change whose independent review
exists.

That was reproduced against this very change's session, which had labelled eight
group reviews and no final one. **Partial adoption is worse than none.** The
final reviewer is dispatched from [review.md](./review.md), which carries the
same rule as a hard gate.

The dispatch stamp does not soften this rule — it only narrows one way it used
to bite. A missing `final` bucket the host read from a **complete** binding is
still a measured negative and still refuses at `forge phase done`; no stamp
overrides it, because a label printed with no dispatch ever carrying it is not
a review. A host-recorded **stop** — the operator declining the reviewer — is
the same story on a partial binding as on a complete one, *provided the stop
itself is on record in a surviving bound transcript*: it is a fact about a
dispatch that exists, not an absence, and the stamp only ever stands in for
an absence, so it never overrides a recorded stop. (The narrower, disclosed
gap — a dispatch whose own transcript, stop included, is entirely pruned,
which then reads as a plain absence the stamp can recover — is the
mechanism's accepted over-credit direction; see [review.md](./review.md) for
that trade-off stated in full.) What changed here is narrower than either of
those: the session whose *older* host transcript has since been pruned and
whose `final` bucket is *missing*, not stopped. There, the same missing
bucket used to be indistinguishable from the
complete-binding case above and refused a change that genuinely had a
labelled final reviewer. Now, if that dispatch left a stamp, the stamp is
read from the session's own directory rather than the pruned transcript and
the reviewer is no longer lost. Group labels still buy nothing beyond arming
the rule above — this only affects the *final* unit's own dispatch record.

**Head every review file with who wrote it as well.** A dispatched reviewer names
its resolved model (`Reviewer: claude-opus-5 (task-reviewer)`); a review you wrote
yourself must declare it in one of the phrases `forge score` recognises, and the
list is **closed**: `self-check`, `self-review`, `self-audit`, `self-authored`,
`Reviewer: coordinator`, `reviewed by the coordinator`, `APPROVED (pace …)`,
`SKIPPED (pace …)`.
Describing it in your own words — *"I wrote this myself, no subagent ran"* —
scores as an outside reader you never had.

*Head* is literal too: put the phrase in the **opening two paragraphs**
(blank-line separated, any length). Below that only a line beginning `Reviewer:`
is reliably read, and it still has to carry one of the phrases — `Reviewer:
coordinator` works anywhere in the file, `Reviewed by: coordinator` does not.

**For the files this phase writes — `task-review.md` and `group-review.md` — that
wording is not a fallback. It is the whole answer, always.** Host evidence is
scoped to the *final* review only, so a group review is classified from its words
even when the session has full host evidence including that group's own dispatch.
The census infers independence from the absence of a declaration, so an
unrecognised phrasing is scored as an outside reader you never had — and lands
permanently in `sessions.jsonl` and the fleet totals.

**Label the final reviewer. Group labels are optional and buy nothing.**
Measured: identical sessions with and without a labelled group reviewer produce
a verdict, score and digest line identical in every field that does not vary with
wall clock or path — `units` is read for `final` and nothing else. What a group label *does* do is tell Forge the convention is in
use, which arms the rule above: label a group and forget the final reviewer and
a high-risk change is refused. So the safe orders are *label the final reviewer*
(group labels then harmless) or *label nothing*. "Label everything" is only safe
while you never forget the one that counts, and its failure is silent.

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

## Per-task loop

1. Extract full task text + file paths + relevant **capability** spec sections (not only the task checkbox line).
2. Write `.forge/sessions/<id>/tasks/<nn>-<slug>/brief.md` using [../subagents/implementer-prompt.md](../subagents/implementer-prompt.md). Fill `{SESSION_ID}` with the current session id and `{TASK_ID}` with this task directory id; never leave either target for the implementer to infer from `.forge/active.json`.
3. Dispatch **implementer** subagent — brief includes [../references/tdd-core.md](../references/tdd-core.md). **Model:** follow [../references/model-selection.md](../references/model-selection.md) — resolve via `forge resolve-model --tier <fast|standard|capable>` (billing defaults to **`included`**). Use `fast` for mechanical tasks (1–2 files, complete spec) and batched small tasks; `standard` for multi-file integration; escalate one capability tier (still `included`) when re-dispatching after `BLOCKED`. If `omitModel` is true, **omit** the Task `model` parameter entirely (never pass a host-list slug); otherwise pass `model` exactly.
4. **Reviewer** (unless pace skips it):
   - **`always` / high-risk hard floor:** dispatch [../subagents/task-reviewer-prompt.md](../subagents/task-reviewer-prompt.md) for this task → `task-review.md`.
   - **`per-group` at group boundary:** dispatch one reviewer covering **all tasks in the just-finished `tasks.md` group** → `group-review.md` (include each task id + paths). Mid-group low-risk tasks: self-check `task-review.md` only.
   - If `review.depth` is `spec-only`, focus on spec + tests evidence. Fill `{SESSION_ID}`, `{TASK_ID}`, `{TDD_EVIDENCE_ENABLED}`, `{DIFF_RANGE}`, `{CAPABILITY_SPEC_EXCERPT}`, and `{GUARD_ALLOWANCES}` (paste `.forge/sessions/<id>/guard-allowances.json`'s contents — there is no `forge guard list` to generate this — or "none" if the file doesn't exist) — read actual code, not the implementer's summary. **Model:** [../references/model-selection.md](../references/model-selection.md) — `forge resolve-model --tier standard` (or `capable` for money/auth/contracts; use `fast` when `models.bias` is `prefer-fast` and not high-risk). Honor `omitModel` / `model` literally. Do **not** skip high-risk tasks.
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
7. Mark task complete in `tasks.md` (`- [ ]` → `- [x]`). That checklist is the source of truth — fleet/status/health derive `tasksComplete` from it (and heal the session cache). Still run the progress command below when you want `--subagents` updated. Detect group boundary: next line in `tasks.md` is a new `##` heading, or no remaining tasks under the current heading.
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

**Batching:** consecutive small same-area tasks (docs, config, wording) may share one implementer brief + one review — see the batching rules in [subagent-driven-development](../skills/subagent-driven-development/SKILL.md). Never batch money/auth/contract/migration tasks.

```bash
forge phase implement --tasks-complete <N> --subagents <total dispatched so far>
```

## Guarded files

A test file that already existed at the session's `baseCommit` (matching
`guard.testGlobs`), plus Forge's own integrity artifacts (`spine.json`,
`e2e.json`, `e2e-results.json`, `verify-evidence.md`, `test-evidence.md`,
`tdd-runs.jsonl`), is **guarded** against tool-call edits: a `PreToolUse` hook
on `Edit`/`Write`/`NotebookEdit`/`MultiEdit` denies implementer edits to it
during implement/verify/review/finish. Tests an implementer writes fresh
during this session are not guarded — TDD still works. `verify-evidence.md`
is the one exception to the implement-onward window: it is authored during
verify itself (see [verify.md](./verify.md)), so it stays editable through
implement and verify and freezes starting review.

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
