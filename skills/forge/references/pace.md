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
See [docs/forge.md](../../../docs/forge.md) § Checkout-local overrides.

## Announce

At session start: `Using Forge for this work. Pace: auto → brisk (…)` (use
`resolved` from `forge status` / session reminder).

## Presets (effort matrix)

| Knob | `thorough` | `standard` | `brisk` | `lite` |
|------|------------|------------|---------|--------|
| **review.perTask** | always | per-group | high-risk-only | never\* |
| **review.final** | always | always | high-risk-only | never\* |
| **review.depth** | full | full | spec-only | spec-only |
| **review.maxRounds** | 3 | 2 | 1 | 0 |
| **verify.tier3** | full-workspace | full-workspace | affected-only | audit-tier2-only |
| **models.bias** | default | default | prefer-fast | prefer-fast |
| **brainstorm.depth** | full | full | short (≤2–3 options) | minimal |

\*Hard floor: money / auth / shared contracts / migrations / secrets **always**
get a per-task review (and final review if the session touched high-risk work),
even under `lite` / `brisk` / mid-group `standard`.

**`thorough` vs `standard`:** thorough reviews **every task**; standard reviews once per **OpenSpec group** (top-level `##` section in `tasks.md`), except high-risk tasks which still get an immediate per-task review.

**`auto`:** resolve once at session start from signals; sticky for the session (not a separate knob matrix).

## Auto signals (stricter wins)

1. money, payment, stripe, billing, auth, oauth, hmac, secret, migration, contract, gdpr → **thorough**
2. ecosystem, cross-workspace, multi-file, openapi, public API, shared package → **standard**
3. docs, readme, rename, typo, scaffold, wording, comment → **lite**
4. else → **brisk**

## Agent rules by knob

### `review.perTask`

Cadence for the task/group reviewer (name is historical — values cover more than “per task”):

- `always` — dispatch task reviewer after **every** implementer (`thorough`).
- `per-group` — dispatch one reviewer when an OpenSpec **group** completes (`standard`). A group is a top-level `##` section in `openspec/changes/<name>/tasks.md` (all `- [ ]` items under that heading until the next `##`). Mid-group low-risk tasks get a pace self-check `task-review.md` only. If `tasks.md` has **no** section headings, treat the whole file as one group (review once when all tasks are done). High-risk tasks still get an **immediate** per-task review (hard floor).
- `high-risk-only` — skip reviewer for low-risk tasks; still write a short self-check note in `task-review.md` (`APPROVED (pace: brisk/lite — self-check)`).
- `never` — same as high-risk-only after hard floor (low-risk may self-check only).

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

- `full` — existing brainstorming skill.
- `short` — at most 2–3 approaches; faster approval.
- `minimal` — confirm intent + one approach; skip long exploration when design is obvious.

## Unchanged (all paces)

- Tier 1 TDD + tier 2 `test-evidence.md` for behavior changes.
- No autonomous git commit/push.
- OpenSpec propose/apply/archive when in Forge.
- `/forge:skip` still exits Forge entirely.
