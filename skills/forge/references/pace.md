# Forge pace (thoroughness)

Checkout-local preferences control how much review/verify ceremony Forge runs.
Defaults live in `preferences.defaults.json`; optional overrides in
gitignored `.forge/preferences.local.json` (**file appears only after a set**).

```bash
forge prefs                         # print effective — does NOT write a file
forge prefs -- auto|thorough|standard|brisk|lite   # WRITE preferences.local.json
forge prefs -- --set review.perTask=always
forge prefs --session-set brisk  # this session only (no local file)
forge prefs -- --resolve --signal "add stripe refund"
forge doctor                        # OpenSpec project + CLI
```

Billing lane (orthogonal): `forge models` prints only;
`forge models included|metered` writes `.forge/models.local.json`.
See [docs/forge.md](../docs/forge.md) § Checkout-local overrides.

## Announce

At session start: `Using Forge for this work. Pace: auto → brisk (…)` (use
`resolved` from `forge status` / session reminder).

## Presets (effort matrix)

| Knob | `thorough` | `standard` | `brisk` | `lite` |
|------|------------|------------|---------|--------|
| **review.perTask** | per-group | per-group | never\* | never\* |
| **review.final** | always | always | always | always |
| **review.depth** | full | full | spec-only | spec-only |
| **review.maxRounds** | 3 | 2 | 1 | 1 |
| **verify.tier3** | full-workspace | full-workspace | affected-only | audit-tier2-only |
| **models.bias** | default | default | prefer-fast | prefer-fast |
| **brainstorm.depth** | full | full | short (≤2 rounds) | minimal |

\*Hard floor: money / auth / shared contracts / migrations / secrets **always**
get a per-task review (and final review if the session touched high-risk work),
even under `lite` / `brisk` / mid-group `standard`. Match the **task line**,
not the change name — hmac or migrate in the slug does not make fixture or
docs tasks 1:1.

**`thorough` vs `standard`:** identical cadence — both review once per
**`tasks.md` group** (top-level `##` section), except high-risk
tasks which still get an immediate per-task review — and identical review
`depth` (`full`). They differ only in `maxRounds`: thorough allows 3
fix→re-review rounds before escalating remaining findings to the human,
standard allows 2.

**`auto`:** resolves from signals at session start, then may re-resolve at plan time and via task-count escalation (below) — not a separate knob matrix.

## Auto signals (stricter wins)

1. money, payment, stripe, billing, auth, oauth, hmac, secret, migration, contract, gdpr → **standard**, and never `brisk`/`lite`. Risk is a property of a *task*: the per-task hard floor below already reviews every high-risk task on every pace, so escalating the whole session to `thorough` only bought per-task reviewers for the low-risk work beside it. Pin with `forge prefs thorough` when you want the old behavior.
2. ecosystem, cross-workspace, multi-file, openapi, public API, shared package, **worker**, **job queue**, **pipeline**, **etl**, **service(s)**, **platform**, **orchestration**, **openspec**, **forge:apply**, **harmonization** → **standard**
3. docs, readme, rename, typo, scaffold, wording, comment, changelog → **lite**
4. fix, tweak, button, toolbar, style, padding, alignment, copy, label (explicitly small) → **brisk**
5. else (including empty / unrecognized scope) → **standard** (fail closed — never default to brisk)

### Plan-time re-resolution (both directions)

Long-standing since 0.3.17, **not new**: on the way into **implement**, `auto`
pace re-resolves from the plan (`suggestPaceFromPlan`) instead of staying with
whatever the session-start slug signal picked. By this point task count,
capability count, wired spine rows and risk are known facts, not a guess from
free text — and the move can go **either direction**: a small
single-capability plan with no wired spine rows resolves down to `brisk` even
from a `standard` start; a plan with ≥15 tasks or ≥2 spine rows resolves up to
`standard` even from a `brisk`/`lite` start. This runs *before* the
task-count escalation below, so a plan that lands on `brisk` here can still be
escalated by `--tasks-total` next.

What **is** new in this change is the record, not the resolution: a downward
move sets `paceDeescalated: true` on the session so a scorecard reader can see
the session dropped ceremony rather than reading the lower pace as if it had
been the starting point. A user pin still short-circuits the resolved pace,
but the plan signal is still compared against it — when the two disagree,
`paceSuppressed.plan` records what the plan would have chosen and why.
Agreement between the pin and the signal is not suppression and is not
recorded.

### Task-count escalation

When `forge phase … --tasks-total N` sets **N ≥ 15** and the session's
`resolvedPace` is still `brisk` or `lite` (and pace is **not** user-pinned),
Forge escalates the session to **`standard`** with
`paceReason: "escalated: N tasks"`. Slug keywords are a poor proxy for scope;
task count is known at plan time. A pin here is likewise recorded, not just
skipped: `paceSuppressed.taskCount` when a pinned session would otherwise have
escalated.

## Plan-time exit ramp

New in this change: right after brainstorm, before any change directory is
scaffolded, `forge exit-check --tasks N --capabilities N --spine-rows N
[--high-risk]` decides whether to *offer* leaving Forge for this work — the
agent supplies the counts because nothing is readable from disk yet to read
them from.

- Exit 0 — the shape qualifies (≤5 tasks, single capability, no wired spine
  rows, not high-risk) — offer to leave Forge.
- Exit 1 — proceed to plan. Also the fail-closed result for a missing,
  non-numeric, negative, fractional, flag-shaped, or repeated count flag.
- Zero tasks never qualifies — unshaped work is not small work.
- High-risk never qualifies, however small.

Either answer gets recorded on the session: accept with
`forge phase skipped --exit-reason "<reason>"`, decline with
`forge phase plan --exit-declined "<reason>"` — both take the reason
`exit-check` printed.

## Ceremony (session tail) — orthogonal to pace

On the way into implement, Forge also resolves **`resolvedCeremony`** from the
plan: **`combined`** (≤5 tasks, single capability, no wired spine rows, not
high-risk → one closer pass replaces the separate verify + review phases; see
`phases/close.md`) or **`full`** (the existing tail). Pace pinning does not
override it — pinning `thorough` is a statement about review cadence, not a
request for three context-reestablishing tail phases on a two-task change. The
floor is one-way: high-risk or spine-rowed changes are always `full`.

## Runtime integrity

Always-on rules (all paces): [runtime-integrity.md](./runtime-integrity.md) —
no stubs / false success, runtime owner required, tests must fail on a no-op,
specs beat narrow tasks, E2E-or-BLOCKED before done. Defaults:
`integrity.forbidStubs`, `integrity.specsBeatNarrowTasks`,
`integrity.requireE2E` in `preferences.defaults.json` (surfaced by `forge status`).

## Agent rules by knob

### `review.perTask`

Cadence for the task/group reviewer (name is historical — values cover more than “per task”):

- `always` — dispatch task reviewer after **every** implementer. No current preset uses this; pin it with `forge prefs -- --set review.perTask=always` for the old thorough behavior.
- `per-group` — dispatch one reviewer when an OpenSpec **group** completes (`thorough`, `standard`). A group is a top-level `##` section in `openspec/changes/<name>/tasks.md` (all `- [ ]` items under that heading until the next `##`). Mid-group low-risk tasks get a pace self-check `task-review.md` only. If `tasks.md` has **no** section headings, treat the whole file as one group (review once when all tasks are done). High-risk tasks still get an **immediate** per-task review (hard floor).
- `high-risk-only` — skip reviewer for low-risk tasks; still write a short self-check note in `task-review.md` (`APPROVED (pace: brisk/lite — self-check)`). No current preset uses this either.
- `never` — same as high-risk-only after hard floor (`brisk`, `lite`; low-risk may self-check only).

### `review.final`

- Skip final reviewer subagent when `never` / `high-risk-only` and session is not high-risk; write `reviews/final-review.md` noting `SKIPPED (pace=…)`.

### `review.depth`

- `spec-only` — task reviewer checks spec compliance + tests evidence; skip broad quality essay.
- `full` — spec then quality (existing task-reviewer prompt).

### `review.maxRounds`

- Cap fix→re-review loops; after the cap, escalate to the human with remaining findings.

### `verify.tier3`

- `full-workspace` — current verify.md behavior.
- `affected-only` — run tests only for workspaces touched by the change (still record `verify-evidence.md`).
- `audit-tier2-only` — audit per-task evidence; do **not** run full suite; note deferred to push/CI in `verify-evidence.md`.

### `models.bias`

- `prefer-fast` — prefer `--tier fast` for implementers when the brief is mechanical; reviewers use `fast` unless high-risk (then `standard`).
- `default` — existing role-based tiers.

### `brainstorm.depth`

- `full` — frontier rounds until the frontier is empty (see the brainstorming skill).
- `short` — cap at ~2 rounds; remaining open branches fold into recommended-answer entries in the design's Assumptions section.
- `minimal` — at most one intent-confirming round; unasked branches become Assumptions.

## Unchanged (all paces)

- Tier 1 TDD + tier 2 `test-evidence.md` for behavior changes.
- No autonomous git commit/push.
- OpenSpec propose/apply/archive when in Forge.
- `/forge:skip` still exits Forge entirely.
