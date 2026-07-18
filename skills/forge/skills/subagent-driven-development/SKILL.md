---
name: subagent-driven-development
description: Forge — subagent per task with a combined spec+quality review. Internal skill; read via forge orchestrator.
---

# Subagent-Driven Development

Execute a plan by dispatching a fresh implementer subagent per task, followed by one **task reviewer** subagent that checks spec compliance first, then code quality.

**Why subagents:** isolated context per task. You craft exactly the instructions and context each one needs — they never inherit session history — and your own context stays free for coordination.

**Core principle:** fresh implementer per task + combined review (spec gate, then quality) = high quality, fast iteration.

## When to use

Use when you have an implementation plan with mostly independent tasks and you're staying in this session. Tightly coupled tasks or no plan → execute manually or brainstorm first.

## Pace

Honor [../../references/pace.md](../../references/pace.md) (`forge prefs` / session `resolvedPace`). Reviewers may be deferred to **OpenSpec group** boundaries under `standard` (`per-group`), or skipped for low-risk work under `brisk`/`lite`; **never** skip review for money/auth/contracts/migrations (immediate per-task review). Tier-2 test evidence stays mandatory for behavior changes on every task.

## Per-task loop

1. Extract full task text + context from the plan (read the plan file **once**, up front; never make a subagent read it). Note which OpenSpec **group** (`##` section) the task belongs to.
2. Dispatch **implementer** — [../../subagents/implementer-prompt.md](../../subagents/implementer-prompt.md). Answer any questions it asks before letting it proceed.
3. Dispatch **reviewer** when pace requires it — [../../subagents/task-reviewer-prompt.md](../../subagents/task-reviewer-prompt.md) (spec compliance gates quality):
   - `always` → after this task
   - `per-group` → after the last task in the current `##` group (or immediately if high-risk); mid-group low-risk → self-check only
   - `high-risk-only` / `never` → only high-risk (hard floor)
   If skipped, write a pace self-check `task-review.md`. Group reviews write `group-review.md` covering every task in the section.
4. Reviewer REJECTED → same implementer fixes → re-review. Repeat until APPROVED (cap at `review.maxRounds`). Never skip the re-review when a reviewer was dispatched.
5. Save test evidence; mark task complete.
6. After all tasks: proceed to verify/review phases (final reviewer subject to pace).

## Task batching (small tasks only)

Each dispatch pays a full fresh context. Batch **consecutive, small, same-area tasks** (doc edits, config values, wording, mechanical renames) into one implementer brief listing them all, reviewed together in one review pass.

**Never batch** tasks that touch money, auth, shared contracts, or migrations — those keep 1:1 dispatch. When in doubt, don't batch.

## Model selection

Subagent models use **two axes** — never invent host model IDs from memory:

| Axis | Values | Default |
| ---- | ------ | ------- |
| Capability | `fast` · `standard` · `capable` | role-based (below) |
| Billing | `included` · `metered` | **`included`** |

**Billing `included` unless the user explicitly asks for API/metered models** (or has set `forge models -- metered`). Do **not** auto-switch to `metered` on failure.

Capability by role:

- Touches 1–2 files with a complete spec → `fast` (most tasks, when the plan is well-specified)
- Multi-file integration, pattern matching, debugging → `standard`
- Design judgment, broad codebase understanding, review → `capable`

Before every Task/Agent dispatch, resolve:

```bash
forge resolve-model --tier <fast|standard|capable>
```

Honor the JSON: if `omitModel` is true, **omit** the host `model` parameter; otherwise pass `model` exactly as returned. Defaults live in `models.defaults.json`. Checkout overlay `.forge/models.local.json` exists only after `forge models included|metered` (bare `forge models` only prints).

## Handling implementer status

- **DONE** → proceed to review.
- **DONE_WITH_CONCERNS** → read the concerns; correctness/scope concerns get addressed before review, observations are noted.
- **NEEDS_CONTEXT** → provide the missing context, re-dispatch.
- **BLOCKED** → context problem: add context, re-dispatch. Needs more reasoning: escalate **capability tier** within the current billing lane (still `included` by default). Task too large: split it. Plan wrong: escalate to the human. Never force the same model to retry unchanged; never flip to `metered` without an explicit user request.

## Red flags — never

- Start implementation on main/master without explicit user consent
- Skip the review, proceed with unfixed spec gaps or Critical/Important issues, or accept "close enough" on spec compliance
- Dispatch multiple implementer subagents in parallel (conflicts)
- Make a subagent read the plan file, skip scene-setting context, or ignore its questions
- Let implementer self-review replace the reviewer (both are needed)
- Fix a failed task manually in coordinator context — dispatch a fix subagent with specific instructions

## Integration

- **Plan source:** OpenSpec (`openspec/changes/<name>/tasks.md`)
- **Subagents must follow:** [references/tdd-core.md](../../references/tdd-core.md) (condensed TDD rules; full skill at [skills/test-driven-development](../test-driven-development/SKILL.md) when stuck)
- **On blockers:** [skills/systematic-debugging](../systematic-debugging/SKILL.md) before guessing fixes
- **After all tasks:** [phases/verify.md](../../phases/verify.md) → [phases/review.md](../../phases/review.md) → [phases/finish.md](../../phases/finish.md)
