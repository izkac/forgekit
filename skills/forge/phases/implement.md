# Implement phase

Read and follow [../skills/subagent-driven-development/SKILL.md](../skills/subagent-driven-development/SKILL.md).

Every implementer subagent must follow [../references/tdd-core.md](../references/tdd-core.md) (condensed TDD rules — the brief includes the pointer; full skill only when stuck).

On test failures or unexpected behavior, use [../skills/systematic-debugging/SKILL.md](../skills/systematic-debugging/SKILL.md) before proposing fixes.

**Test strategy:** [../references/test-strategy.md](../references/test-strategy.md) — tier 1 (scoped TDD) + tier 2 (narrow task evidence) during implement; **tier 3 (full workspace) runs once at verify**, not per task.

**Pace:** Read `resolvedPace` / effective knobs from `forge status` (or [../references/pace.md](../references/pace.md)). After each task, decide whether to dispatch a reviewer via `review.perTask` + hard floor:

| `review.perTask` | When to dispatch reviewer |
| ---------------- | ------------------------- |
| `always` | After every task (`thorough`) |
| `per-group` | When the task closes an OpenSpec `tasks.md` group (`##` section), or immediately if the task is high-risk (`standard`) |
| `high-risk-only` / `never` | Only when hard-floor high-risk |

When skipping the reviewer, still write `task-review.md` with `APPROVED (pace self-check)` and keep tier-2 evidence mandatory for behavior changes. For `per-group` reviews, cover all tasks in that section in one reviewer pass; save as `group-review.md` next to the group’s tasks (or under `.forge/sessions/<id>/tasks/group-<nn>-<slug>/group-review.md`). Prefer `--tier fast` when `models.bias` is `prefer-fast` and the task is mechanical. Cap fix→re-review loops at `review.maxRounds`.

## Plan source

| planType | Task list |
| -------- | --------- |
| `openspec` | `openspec/changes/<name>/tasks.md` via **`/forge:apply`** (preferred), **`openspec-apply-change`** / `/opsx:apply` |

Legacy sessions with planType `throwaway` or `direct`: resume from the session's own artefacts (`plan.md` / `brainstorm/notes.md`); new work is always `openspec`.

For OpenSpec: follow `openspec-apply-change` for CLI steps, but **wrap each task** in the subagent loop (do not implement all tasks inline in coordinator context).

## Per-task loop

1. Extract full task text + file paths + relevant spec sections.
2. Write `.forge/sessions/<id>/tasks/<nn>-<slug>/brief.md` using [../subagents/implementer-prompt.md](../subagents/implementer-prompt.md).
3. Dispatch **implementer** subagent — brief includes [../references/tdd-core.md](../references/tdd-core.md). **Model:** resolve via `forge resolve-model --tier <fast|standard|capable>` (billing defaults to **`included`** — subscription/first-party pool; never invent API model slugs). Use `fast` for mechanical tasks (1–2 files, complete spec) and batched small tasks; `standard` for multi-file integration; escalate one capability tier (still `included`) when re-dispatching after `BLOCKED`. If `omitModel` is true, omit the Task `model` parameter.
4. **Reviewer** (unless pace skips it):
   - **`always` / high-risk hard floor:** dispatch [../subagents/task-reviewer-prompt.md](../subagents/task-reviewer-prompt.md) for this task → `task-review.md`.
   - **`per-group` at group boundary:** dispatch one reviewer covering **all tasks in the just-finished OpenSpec group** → `group-review.md` (include each task id + paths). Mid-group low-risk tasks: self-check `task-review.md` only.
   - If `review.depth` is `spec-only`, focus on spec + tests evidence. Fill `{DIFF_RANGE}` — read actual code, not the implementer's summary. **Model:** `forge resolve-model --tier standard` (or `capable` for money/auth/contracts; use `fast` when `models.bias` is `prefer-fast` and not high-risk). Do **not** skip high-risk tasks.
5. Fix loop until the reviewer approves (max `review.maxRounds` from pace; then escalate to the human). For group reviews, fix any rejected task in the group before continuing to the next group.
6. Record **test evidence** from the implementer's report (every task, even when review is deferred to group end):
   ```bash
   forge evidence --task <nn>-<slug> --command "<tier-2 cmd>" --exit 0 --summary "<pass summary>"
   ```
   (Refuses non-zero exit without `--allow-fail`; template + rules in [../references/test-evidence.md](../references/test-evidence.md).)
7. Mark task complete (`tasks.md` `- [x]` or update `tasksComplete`). Detect group boundary: next line in `tasks.md` is a new `##` heading, or no remaining tasks under the current heading.
8. Repeat.

**Batching:** consecutive small same-area tasks (docs, config, wording) may share one implementer brief + one review — see the batching rules in [subagent-driven-development](../skills/subagent-driven-development/SKILL.md). Never batch money/auth/contract/migration tasks.

```bash
forge phase implement --tasks-complete <N> --subagents <total dispatched so far>
```

## Forge constraints (include in every brief)

- **No** autonomous `git commit` or `git push`
- **Tier 2 tests only** before claiming task done — narrowest command for this task ([test-strategy.md](../references/test-strategy.md)); **not** the full workspace suite unless the task requires it
- Trace ecosystem consumers when contracts change
- Minimal diff — surgical changes only

## After all tasks

Proceed to [verify.md](./verify.md) then [review.md](./review.md).
