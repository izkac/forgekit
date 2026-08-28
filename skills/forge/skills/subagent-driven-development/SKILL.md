---
name: subagent-driven-development
description: Forge — subagent per task with a combined spec+quality review. Internal skill; read via forge orchestrator.
---

# Subagent-Driven Development

Execute a plan by dispatching a fresh implementer subagent per **work unit** — by default one `tasks.md` group — followed by one **task reviewer** subagent that checks spec compliance first, then code quality.

**Why subagents:** isolated context per unit. You craft exactly the instructions and context each one needs — they never inherit session history — and your own context stays free for coordination.

**Core principle:** fresh implementer per unit + combined review (spec gate, then quality) = high quality, fast iteration. The unit is as small as the risk demands and as large as the coupling allows — see [Work units](#work-units-what-one-implementer-dispatch-covers).

## When to use

Use when you have an implementation plan with mostly independent tasks and you're staying in this session. Tightly coupled tasks or no plan → execute manually or brainstorm first.

## Pace

Honor [../../references/pace.md](../../references/pace.md) (`forge prefs` / session `resolvedPace`). Reviewers may be deferred to **`tasks.md` group** boundaries under `standard` (`per-group`), or skipped for low-risk work under `brisk`/`lite`; **never** skip review for a task whose **own line** is money/auth/contracts/migrations (immediate per-task review). A high-risk change name does not make every task 1:1. Tier-2 test evidence stays mandatory for behavior changes on every task.

## Per-unit loop

1. Extract full task text + context from the plan (read the plan file **once**, up front; never make a subagent read it). Group the tasks into **work units** (below) — by default one unit per OpenSpec **group** (`##` section).
2. Dispatch **implementer** for the unit — [../../subagents/implementer-prompt.md](../../subagents/implementer-prompt.md), listing every task in the unit in order. Answer any questions it asks before letting it proceed.
3. Dispatch **reviewer** when pace requires it — [../../subagents/task-reviewer-prompt.md](../../subagents/task-reviewer-prompt.md) (spec compliance gates quality), covering every task in the unit in one pass:
   - `always` → after this unit
   - `per-group` → after the last unit in the current `##` group (or immediately if high-risk); mid-group low-risk → self-check only
   - `high-risk-only` / `never` → only high-risk (hard floor)
   If skipped, write a pace self-check `task-review.md`. Group reviews write `group-review.md` covering every task in the section.
4. Reviewer REJECTED → same implementer fixes → re-review. Repeat until APPROVED (cap at `review.maxRounds`). Never skip the re-review when a reviewer was dispatched.
5. Save test evidence; mark each task in the unit complete.
6. After all units: proceed to verify/review phases (leftover sweep: specs always → `spec-verify.md`; OpenSpec when available → `openspec-verify.md`; then final reviewer subject to pace).

## Work units (what one implementer dispatch covers)

**The unit of dispatch is the group, not the task.** Each dispatch pays a full
fresh context: the subagent re-reads the spec, the constraints and the files it
needs, and none of that is shared with the next one. Measured on the hard-v2 eval
arm, that ramp-up — not review verdicts — was where Forge's input tokens went. A
four-task group dispatched task-by-task pays it four times for one group's worth
of code.

So the default is **one implementer per `tasks.md` group**, working its tasks in
order, keeping its context warm across them.

**Split a group into smaller units when any of these is true:**

- **A task is high-risk** — money, auth, shared contracts, migrations, secrets.
  Those keep 1:1 dispatch, always, with their own review. Match that **task
  line**, not the change slug. Not negotiable, and not a judgment call about
  how risky the rest of the change looks.
- **The group exceeds 4 tasks.** Split into units of at most 4. A long unit puts
  more work behind one failure and eventually spends the context it was saving.
- **A later task needs an earlier task's review verdict** — a real dependency on
  the *review*, not just on the code.
- **The tasks share nothing** — different subsystems, no common files, no common
  spec section. There is little warm context to reuse, so split if it makes the
  brief clearer.

When in doubt inside one group, keep them together; when in doubt across groups,
split.

**A unit is one dispatch, not one task's worth of rigor.** Inside it, every task
keeps everything it had alone:

- its own red→green cycle and its own `forge tdd run --task <task-id>` stamps
  (the command creates each task's directory, so one subagent stamps several)
- its own `tasks.md` checkbox, ticked as it lands
- its own entry in the review packet

The saving is the ramp-up, and only the ramp-up. A unit that skips a task's red
stamp has not saved anything — it has produced a change that refuses at
`forge phase done`.

## Model selection

**Canonical rules:** [../../references/model-selection.md](../../references/model-selection.md) — read before any dispatch. Summary:

Subagent models use **two axes** — you choose only the **tier**; never invent host model IDs:

| Axis | Values | Default |
| ---- | ------ | ------- |
| Capability | `fast` · `standard` · `capable` | role-based (below) |
| Billing | `included` · `metered` | **`included`** |

**Billing `included` unless the user explicitly asks for API/metered models** (or has set `forge models metered`). Do **not** auto-switch to `metered` on failure.

Capability by role (this is the `--tier` argument only):

- Unit touches 1–2 files with a complete spec, or is mechanical throughout (docs, config, wording, renames) → `fast`
- Multi-file integration, pattern matching, debugging → `standard`
- Design judgment, broad codebase understanding, review → `capable`

Before every Task/Agent dispatch, resolve:

```bash
forge resolve-model --tier <fast|standard|capable>
```

Honor the JSON **literally**:

- `omitModel: true` → **omit** the host `model` parameter entirely. Do **not** pass a slug from the host’s available-models list, docs, or memory — that overrides inherit and can **bill the user**.
- `omitModel: false` → pass `model` **exactly** as returned.

Defaults live in `models.defaults.json`. Checkout overlay `.forge/models.local.json` exists only after `forge models included|metered` (bare `forge models` only prints) or a hand-written per-tier overlay.

Claude Code projects may enforce that overlay at dispatch time (`forge enforce-model` on `PreToolUse`). Two things follow: a dispatch may come back **rewritten** to a different model than you asked for — that is the project's policy, not an error — and a **denied** dispatch names the resolved set. On a denial, run the resolver and re-dispatch with what it returns; never retry the same model.

## Handling implementer status

- **DONE** → proceed to review.
- **DONE_WITH_CONCERNS** → read the concerns; correctness/scope concerns get addressed before review, observations are noted.
- **NEEDS_CONTEXT** → provide the missing context, re-dispatch.
- **BLOCKED** → context problem: add context, re-dispatch. Needs more reasoning: escalate **capability tier** within the current billing lane (still `included` by default). Task too large: split it. Plan wrong: escalate to the human. Never force the same model to retry unchanged; never flip to `metered` without an explicit user request.

## Red flags — never

- Pass a `model` slug you picked yourself (host model list, “capable-sounding” product ids, memory) — especially when `omitModel` is true
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
- **After all tasks:** [phases/verify.md](../../phases/verify.md) (includes leftover sweep: `spec-verify.md` for specs, `openspec-verify.md` for OpenSpec when available) → [phases/review.md](../../phases/review.md) → [phases/finish.md](../../phases/finish.md)
