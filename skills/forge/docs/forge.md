# Forge — disciplined development workflow

Forge is an **OpenSpec-native**, **self-contained** development pipeline.
All workflow skills (brainstorm, TDD, subagents, verify, review) live under the
Forge skill’s `skills/` folder — **no Superpowers plugin required**.

It does not stop at green unit tests or checked-off tasks: **runtime integrity**
requires a named production path for every claimed capability, and (for
jobs/workers) a closed product loop before `forge phase done`. See
[Runtime integrity](#runtime-integrity).

**Using Forgekit for the first time?** Start with the tutorial:
[**How to use Forgekit**](https://github.com/izkac/forgekit/blob/main/docs/usage.md) (install → init → `/forge:apply` → examples).

**Skill:** `forge` (Cursor, Claude Code, Codex CLI)  
**Commands:** `/forge`, `/forge:*` (after `forge init`; Cursor and Claude Code)  
**Scratch space:** `.forge/` (gitignored except README)  
**CLI:** `@izkac/forgekit` → `forgekit` (install) · `forge` (workflow) · `review` (standalone deep review)

---

## Install

```bash
# Preferred — once per machine
npm i -g @izkac/forgekit
forgekit install --skills forge --agents cursor,claude
# or: forge install                  # alias → --skills forge
```

```bash
# Once per project
forge init --cursor --claude         # commands, rules, hooks, .forge/
forge init --overlay                 # optional OpenSpec vendor patches
```

Hooks call `forge` on PATH. Merge the generated `forge-hooks.snippet.json`
into your agent settings if hooks are not picked up automatically.

**Editing this file, `pace.md`, or anything else under `skills/forge/`?**
Those edits change this repo checkout, not what's installed. Every machine
running Forge — including this one, if it already installed — keeps reading
its old copy under `~/.agents/skills/forge/…` until it re-runs
`forgekit install --skills forge --force` (or `forgekit update`).

---

## When Forge runs

**Default:** agents **triage** every task. Substantial work enters Forge
automatically unless the user explicitly skips with **`/forge:skip`**.

### Substantial work (enter Forge)

**Forge = OpenSpec.** Enter the full flow only when the work warrants a tracked OpenSpec change — when **any** of:

- New feature or behavior change
- Multi-file or multi-package change
- Public API, contract, or config schema change
- Cross-product / ecosystem impact
- User invokes `/forge`, `/forge:brainstorm`, `/forge:plan`, or `/forge:build`
- Work would likely need an ADR or new OpenSpec capability when done

### Trivial work (skip Forge)

Execute directly when **all** of:

- Question, explanation, or read-only review
- Typo, comment, or purely cosmetic edit
- Single localized change with no contract impact
- User explicitly says **`/forge:skip`** for this task

---

## End-to-end decision tree

This doc uses an **ASCII tree only** — no Mermaid. Lightweight viewers (e.g.
MarkView) render Mermaid flowcharts with broken fills and connectors; ASCII
works everywhere.

```
User request
    │
    ├─ /forge:skip? ── yes ──► Direct execution (no Forge session)
    │
    └─ no
        │
        └─ OpenSpec-worthy / substantial? ── no ──► Direct execution
                │
               yes
                │
                ▼
        Start / resume Forge session
                │
                ▼
           Phase: Brainstorm
                │
                ├─ design not approved ──► (loop back to Brainstorm)
                │
                └─ design approved
                        │
                        ▼
                 Phase: Plan (OpenSpec)
                        │
                        ▼
                 /opsx:propose
                 openspec/changes/<name>/
                        │
                        ▼
                 Phase: Implement
                          │
            ┌─────────────┴─────────────┐
            │  PER UNIT (loop until done) │
            │  unit = one tasks.md group, │
            │  ≤4 tasks; high-risk = 1:1  │
            │  1. Subagent implementer  │
            │     (TDD per task inside) │
            │  2. Reviewer (pace):      │
            │     thorough=per unit     │
            │     standard=per group    │
            │     └─ fail ──► retry     │
            │  (tier 2 narrow evidence) │
            └─────────────┬─────────────┘
                          ▼
         Verify: audit tier 2 + tier 3 (scope from pace)
                  + forge e2e run (green), skip, or BLOCKED
                  + forge integrity-check
                          │
                          ▼
         Final review (pace) — spine + product loop
                          │
                          ▼
                 /opsx:archive (+ project ADR follow-up if any)
                          │
                          ▼
            forge phase done  ← integrity gate (refuses if incomplete)
            Done + cleanup .forge session
```

**Jobs / workers / queues:** spine is mandatory for *every* change (`forge spine
init` — rows or `notApplicable`). Spine rows also require executable acceptance
steps (`forge e2e init` at plan, green `forge e2e run` before done). Async work
also needs wiring + product-loop tasks. See [Runtime integrity](#runtime-integrity).

### Triage (top of tree)

| Check | Outcome |
| ----- | ------- |
| User sent `/forge:skip` | Direct execution |
| Not substantial / not tracked-change-worthy | Direct execution |
| Otherwise | Enter Forge session (tracked change) |

### Planning engine (per project)

Forge always produces a tracked change; the **engine** is project config
(`.forge/config.json` → `plan.engine`, set by `forge init`):

| Engine | Change location | Tooling |
| ------ | --------------- | ------- |
| `openspec` | `openspec/changes/<name>/` | OpenSpec CLI + `/opsx:*` vendor skills |
| `specs` | `<plan.dir>/changes/<name>/` (dir from `plan.dir`, default `specs`) | Built-in — OpenSpec-format markdown (proposal / design / tasks / deltas) |

Selection flow: `forgekit install` asks once for a user default
(`~/.forgekit/config.json` → `plan.engine`); `forge init` uses that default
(or asks Planning engine? when unset), auto-detects `openspec/config.yaml`,
and offers `openspec init` when OpenSpec is chosen but missing. Choosing
OpenSpec always writes `plan.engine: openspec` — setup failure or declining
immediate init does **not** fall back to the built-in specs engine
(`--openspec` / `--no-openspec` skip prompts; `--plan-dir` sets the specs
engine root, e.g. `openspec` to reuse a vendor tree). Migration later: keep
the same tree and flip `plan.engine`, or run `openspec init` if starting fresh.

### Planning (after brainstorm)

Proceed directly to the configured engine's propose flow — do not ask for a plan mode.

| Step | What happens |
| ---- | ------------ |
| **Propose** | `/opsx:propose` → `openspec/changes/<name>/` (openspec) or author `specs/changes/<name>/{proposal,tasks}.md` per [plan-specs.md](../phases/plan-specs.md) (specs) |
| **User approval** | Confirm proposal, design, tasks before implement |
| **Implement** | `/forge:apply` or `/forge:build` against `tasks.md` |

See the Forge skill’s [references/plan-routing.md](../references/plan-routing.md).

---

## Phases

| Phase | What happens | Skills / commands |
| ----- | ------------ | ----------------- |
| **triage** | Substantial? Skip allowed? Bootstrap session | `forge` skill |
| **brainstorm** | Explore intent, approaches, approval | `skills/brainstorming` |
| **plan** | Tracked-change propose; **`forge spine init` every change** (rows or `notApplicable`); rows → `forge e2e init` (steps are a plan deliverable); wiring + product-loop tasks when async | [plan-routing.md](../references/plan-routing.md) |
| **implement** | Subagent per work unit (one `tasks.md` group by default; 1:1 for high-risk), TDD per task, tier 2 evidence; update spine rows; `forge defer` for deferred wiring | **`/forge:apply`** (OpenSpec) or `/forge:build` + `skills/subagent-driven-development` + `skills/test-driven-development` + [test-strategy](../references/test-strategy.md) |
| **verify** | `combined` ceremony (small low-risk change) → one closer pass covers verify + review ([phases/close.md]). Otherwise: audit tier 2; tier 3; green `forge e2e run`; `forge integrity-check`; leftover sweep (`spec-verify.md` always on for specs; `openspec-verify.md` when `openspec-verify-change` is present for OpenSpec) | `skills/verification-before-completion` + `verify-evidence.md` + `spec-verify.md` / `openspec-verify.md` |
| **review** | Covered by the closer when ceremony is `combined`. Otherwise: combined task reviewer (spec + quality) per unit, scoped to the diff range; final review (spine + executed e2e) | `skills/requesting-code-review` |
| **finish** | Archive (+ ADR if the project uses that); `forge phase done` (integrity gate); cleanup | `/opsx:archive`, `forge cleanup` |

**Standalone deep review (outside Forge):** for pre-merge audits with adversarial false-positive filtering, use the **thorough code review** skill — see [thorough-code-review.md](https://github.com/izkac/forgekit/blob/main/docs/thorough-code-review.md). Forge's `requesting-code-review` stays the per-task checkpoint during `/forge:build`.

---

## Which session a bare command acts on

`--session <id>` always wins. With one session open it is used. With several,
`.forge/active.json` decides and the command **says so on stderr** — except the
ones that write a permanent record, which **refuse** and list the candidates:
`forge phase done|finish`, `forge checkpoint`, `forge score --write`,
`forge brief stamp` and `forge review-label` — the last of these also writes a
dispatch stamp (`reviews/dispatches.json`) alongside the printed label, so an
ambiguous session refuses before that write too, not only before the label.

Severity follows what the invocation writes, not the command's name, so
`forge checkpoint --dry-run|--range`, `forge score` without `--write` and
`forge brief check|open` do not refuse. `forge evidence` records with a warning
but will not *overwrite* existing evidence for a guessed session.

`forge phase` marks the session it transitioned as active — below every gate, so
a refused transition does not move it, and never on `done`/`skipped`, so
finished work cannot capture your status line or the resume hook.

## `.forge/` session layout

One session per substantial task. **Per-checkout** active pointer — works across
Cursor, Claude Code, and Codex without requiring a chat ID.

```
.forge/
  active.json                         ← current session (gitignored)
  models.local.json                   ← optional billing overlay
  preferences.local.json              ← optional pace overlay
  sessions/
    2026-06-05T143022Z-my-feature-a3f9b2/
      session.json                    ← phase, planType, openspecChange, pace,
                                        host binding, phaseHistory
      status.json                     ← machine-readable progress
      metrics.json                    ← host telemetry (phase finish|done, or on demand)
      dispatches.jsonl                ← one line per subagent dispatch the policy saw
      brainstorm/
        notes.md
        decisions.md
      plan.md                         ← legacy throwaway plans only (deprecated)
      verify-evidence.md              ← tier 3 + loop narrative (or BLOCKED)
      spec-verify.md                  ← specs leftover sweep (always on for planType: specs)
      openspec-verify.md              ← OpenSpec leftover sweep (when skill present)
      e2e-results.json                ← forge e2e run results (steps hash + per-step outcomes)
      deferrals.json                  ← forge defer registry (when used)
      spine.json                      ← fallback if no tracked change dir
      e2e.json                        ← fallback if no tracked change dir
      scorecard.md / scorecard.json   ← L2 session score (written at done/finish)
      tasks/
        01-first-task/
          brief.md
          test-evidence.md
          task-review.md              ← combined spec + quality verdict
      reviews/
        final-review.md
```

For OpenSpec / specs-engine changes, the canonical **spine matrix** and **e2e
steps** live next to the plan: `openspec/changes/<name>/spine.json` + `e2e.json`
(or `<specsDir>/changes/<name>/…`).

**Session ID:** `<UTC-compact>-<kebab-slug>-<6-hex>`

**Retention:** 14 days. Finished sessions (`phase: done|skipped`) are removed on
the next `forge cleanup`; the session `.forge/active.json` names is kept unless
you pass `--include-active`. An *unfinished* session is never aged out while it
holds anything beyond its own `session.json`, `status.json` and `inbox/` — pass
`--include-unfinished --session <id>` to remove one anyway, which also overrides
the active-session protection for that one id. Nothing removes a session before
its retention window, whatever flags you pass. `--session <id>` scopes the whole
run to that session.

Optional `cursorChatId` on `session.json` when a hook can supply it — not
required for correctness.

---

## Commands (project slash)

| Command | Purpose |
| ------- | ------- |
| `/forge` | Start or resume from active session / current phase |
| `/forge:brainstorm` | Brainstorm phase only |
| `/forge:plan` | Plan phase — tracked-change propose (engine from `.forge/config.json`) |
| `/forge:apply` | **Tracked-change implement** — subagent TDD + verify + review (preferred over `/opsx:apply`) |
| `/forge:build` | Implement phase (`tasks.md` from either engine) |
| `/forge:status` | Show active session progress |
| `/forge:harness` | Ensure a working, recorded project e2e harness (build proactively) |
| `/forge:analyze` | Agent-written improvement report over recent sessions |
| `/forge:skip` | **Explicit** opt-out of Forge for this task |

OpenSpec commands remain available standalone (OpenSpec-engine projects):

| Command | Purpose |
| ------- | ------- |
| `/opsx:propose` | Create OpenSpec change + artifacts |
| `/opsx:apply` | Vendor OpenSpec task loop — **re-overlay** with Forge via `forge overlay`; prefer **`/forge:apply`** |
| `/opsx:archive` | Archive completed change |
| `/opsx:explore` | Explore without committing to a change |

---

## CLI (`forge`)

```bash
forge new <slug> [--signal "…"]   # new session + set active (resolves pace; warn-only doctor)
forge status                      # active session JSON (+ effective pace + health verdict)
forge phase <phase> […]           # update phase / openspec / task counters
forge checkpoint --group <name> [--tasks <ids>]
                                  # commit this group's work (opt-in; never pushes)
forge checkpoint --dry-run        # what a checkpoint would commit
forge checkpoint --range [--last] # diff range for a reviewer brief ({DIFF_RANGE})
forge finding add "<text>" --kind <bug|debt|tradeoff|idea|process> --severity <blocker|major|minor|note> [--change <slug>]
                                  # findings ledger (.forge/findings.jsonl); kind+severity required
forge finding list|resolve|link|reopen
                                  # list defaults to open bugs; status shows stale/reopened
                                  # Rules: fix beats file; re-check dependents; corpus before narrowing heuristics
forge fleet report [--json]       # cross-project trend from the durable ledgers
forge e2e run --repeat 5 [--record-baseline]
                                  # measure harness flakiness; write e2e.baseline
forge cleanup [--dry-run]         # prune sessions >14 days or finished
forge evidence --task <nn>-<slug> --command "<cmd>" --exit 0 --summary "<text>"
                                  # stamp tier-2 test-evidence.md
forge --version                   # forge <version> — which installed copy is answering
forge resolve-model --tier <fast|standard|capable>
                                  # JSON model resolution (included billing by default)
forge enforce-model               # PreToolUse hook body (Claude Code): hold subagent
                                  # dispatches to models.local.json; inert without it
forge models                      # print effective billing (does NOT write a file)
forge models included|metered     # WRITE .forge/models.local.json
forge prefs                       # print effective pace (does NOT write a file)
forge prefs auto|thorough|standard|brisk|lite
                                  # WRITE .forge/preferences.local.json
forge prefs --session-set lite    # pin active session only
forge doctor                      # plan-engine readiness (OpenSpec or specs layout)
forge doctor --install            # attempt npm install -g @fission-ai/openspec
forge spine init|check            # capability→runtime spine matrix (spine.json in change dir)
forge e2e init|run|check          # executable product-loop acceptance (e2e.json + e2e-results.json)
forge defer add|resolve|list      # deferral registry — deferred wiring is tracked debt
forge integrity-check             # mechanical gate: spine + deferrals + executed e2e
forge gate init|check|status      # opt-in per-group executable gates (.forge/config.json → gates.enabled)
forge score [--write] [--md]      # L2 session scorecard (also auto-written at phase done)
forge metrics collect [--session <id>] [--json]
                                  # harvest the host's own transcripts into
                                  # metrics.json — requests, tokens, models, tool
                                  # errors, subagents, dispatch decisions, per phase.
                                  # Also runs automatically at phase finish|done.
                                  # `available: false` (no host, pruned transcript)
                                  # is a normal outcome and exits 0.
forge analyze [--json] [--limit <n>] [--since <date>]
                                  # read .forge/sessions.jsonl + scorecards.jsonl +
                                  # surviving metrics.json back as numbers: coverage
                                  # first, then per-model and per-phase totals and the
                                  # model-policy skip rate. Read-only; writes nothing.
forge overlay                     # re-apply OpenSpec vendor overlays in this project
forge init […]                    # wire project commands / hooks / rules
forge install […]                 # alias → forgekit install --skills forge
```

Meta install (skills × agents):

```bash
forgekit install
forgekit install --skills forge,thorough-code-review --agents cursor,claude
forgekit list
```

---

## Checkout-local overrides (per developer)

Forge has two **optional**, **gitignored** overlays under `.forge/`.
They appear on disk **only after you set them**. Bare get commands only print the
merged effective value from package defaults.

| Concern | Defaults (in `@izkac/forgekit`) | Local file (gitignored) | Get (print only) | Set (creates/updates file) |
| ------- | ----------------------------- | ----------------------- | ---------------- | -------------------------- |
| Subagent **billing** (`included` / `metered`) | `packages/cli/src/models.defaults.json` | `.forge/models.local.json` | `forge models` | `forge models included\|metered` |
| Forge **pace** (review / verify ceremony) | `packages/cli/src/preferences.defaults.json` | `.forge/preferences.local.json` | `forge prefs` | `forge prefs auto\|thorough\|…` |

```bash
# Example: you ran forge models and only saw "included" —
# that means the default lane is in effect. No models.local.json exists yet.
forge models --json                 # localExists: false until you set
forge models included               # now creates .forge/models.local.json

forge prefs --session-set lite      # pin active session only; no local file
```

These are **per-checkout** (each developer’s clone), not committed to git — same
idea as a personal `.env`.

---

## Pace (thoroughness)

Forge ceremony (per-task review, final review, tier-3 verify, model bias, brainstorm
depth) is controlled by a **pace** preset. Default is **`auto`**.

`auto` resolves **twice**. At `forge new` the only signal is a free-text slug, so
that pass fails closed to `standard`. On the way into **implement** it re-resolves
from the plan itself — task count, group count, capabilities, spine rows, and
whether anything in the proposal/design/tasks/spine touches
money/auth/contracts/migrations — which raises the floor to `standard`, not to
`thorough` (the per-task hard floor covers the risky tasks). That second pass is why `brisk` is reachable at
all: classifying a slug returned `standard` on every real session, three of them
via "unrecognized scope — failing closed". The session records
`paceResolvedFrom: "plan"` and a reason naming the facts (`plan: 3 tasks, single
capability, no wired spine rows`). Pinned pace (`forge prefs --session-set`) is
never overridden.

| Pace | Intent |
|------|--------|
| `auto` | Pick thorough / standard / brisk / lite from signals (default) |
| `thorough` | Review once per **OpenSpec group**, same cadence as `standard`, with more fix→re-review rounds before escalating; full-workspace tier 3 |
| `standard` | Review once per **OpenSpec group**; full-workspace tier 3 |
| `brisk` | Review high-risk tasks only; affected-workspace tier 3 (final review still runs) |
| `lite` | Skip per-task review for low-risk (final review still runs); audit tier-2 only at verify |

### Effort matrix (exact knobs)

Defaults from `packages/cli/src/preferences.defaults.json`:

| Knob | `thorough` | `standard` | `brisk` | `lite` |
|------|------------|------------|---------|--------|
| **review.perTask** | per-group | per-group | never\* | never\* |
| **review.final** | always | always | always | always |
| **review.depth** | full | full | spec-only | spec-only |
| **review.maxRounds** | 3 | 2 | 1 | 1 |
| **verify.tier3** | full-workspace | full-workspace | affected-only | audit-tier2-only |
| **models.bias** | default | default | prefer-fast | prefer-fast |
| **brainstorm.depth** | full | full | short (≤2 rounds) | minimal |

\*Hard floor: money / auth / contracts / migrations / secrets still get per-task review (and final if the session touched high-risk), even under `brisk` / `lite` / mid-group `standard`.

**`thorough` vs `standard`:** identical cadence — both review once per OpenSpec `tasks.md` group (`##` section), except high-risk tasks which still get an immediate per-task review — and identical review `depth` (`full`). They differ only in `maxRounds`: thorough allows 3 fix→re-review rounds before escalating remaining findings to the human, standard allows 2.

**`auto`** is not a preset — it resolves from signals at session start, then may re-resolve at plan time and via task-count escalation (below); not a separate knob matrix:

1. money / payment / auth / secret / migration / contract / gdpr → **standard** (never `brisk`/`lite`) — risk raises the floor; the **per-task** hard floor below reviews the risky tasks themselves
2. ecosystem / API / multi-file / shared package / worker / job queue / pipeline / etl / platform / orchestration / openspec → **standard**
3. docs / typo / rename / scaffold / changelog → **lite**
4. fix / tweak / toolbar / style / padding (explicitly small) → **brisk**
5. else (including empty / unrecognized) → **standard** (fail closed)

When `--tasks-total N` is set with **N ≥ 15** and resolved pace is still `brisk`/`lite` (not user-pinned), Forge escalates the session to **standard**.

**Unchanged on all paces:** tier-1 TDD + tier-2 evidence, no autonomous commit, OpenSpec when in Forge. Runtime integrity (below) applies at every pace.

### Ceremony (session tail)

Orthogonal to pace: on the way into implement, Forge resolves **`resolvedCeremony`**
from the plan. **`combined`** — ≤5 tasks, single capability, no wired spine rows,
not high-risk — replaces the separate verify + review phases with **one closer
subagent pass** (diff-read, evidence audit, one tier-3 run, READY/NOT READY);
everything else is **`full`**, the existing tail. Measured motivation: on the
sonnet-hard-v2 cohort the tail cost 2–4M input tokens per trial against
0.4–0.9M for implement. The `forge phase done` integrity gates are identical on
both paths, and high-risk changes can never resolve to `combined`.

Agent rules for each knob: [pace.md](../references/pace.md).

Prefs are gitignored (`.forge/preferences.local.json`), same pattern as `models.local.json`.

### OpenSpec doctor

`forge doctor` checks `openspec/config.yaml` and that `openspec` is on PATH.
If the CLI is missing, it warns and offers `npm install -g @fission-ai/openspec`
(`--install` to attempt). `forge new` runs doctor warn-only so a missing CLI does
not block session creation.

---

## Runtime integrity

Forge’s job is to ship **working product paths**, not green checkboxes over
orphan libraries. Integrity rules live in
[runtime-integrity.md](../references/runtime-integrity.md) and are
enforced by both skill prompts and the CLI.

### The problem it prevents

Without integrity, a large change can look “done” while the product is hollow:

- Libraries (matcher, BI exporter, …) are unit-tested and marked complete
- A worker job logs and marks `succeeded` (or a thin concat job writes a `.sav`)
- The UI can enqueue kinds nobody handles, or read collections nobody writes
- OpenSpec shows 57/57 — but upload → analyze → ratify → run never works

Integrity upgrades Forge from “no false job success” to **product-loop acceptance**.

### Rules (plain language)

1. **No stubs / false success** — a handler that only logs and succeeds is forbidden.
2. **Runtime owner required** — a library alone does not satisfy a capability; name the production caller (job, endpoint, CLI).
3. **Tests must fail on a no-op** — asserting “job status became succeeded” is not enough.
4. **Specs beat narrow tasks** — capability specs win when they conflict with a thin task reading.
5. **E2E = executed product loop** — produce → consume → decision changes output, run as `e2e.json` steps via `forge e2e run` (prose does not count). A single job slice (ingest → Parquet) is **not** platform E2E.
6. **Job-kind closure** — every product-surface job kind is wired end-to-end **or deleted** before complete. “Fail closed” is only a temporary `BLOCKED` state.
7. **Consumer–producer** — if UI/API reads it, production must write it (proven in evidence).
8. **Deferrals are tracked** — “wiring later” only via `forge defer`; unresolved deferrals block `done`.

### Mechanics

| Tool | Purpose |
|------|---------|
| `forge spine init\|check` | **Mandatory every change.** `spine.json`: rows **or** `notApplicable`. Not keyword-gated. |
| `forge e2e init\|run\|check` | **Mandatory when the spine has rows.** `e2e.json` step list executed by `forge e2e run`; results (`e2e-results.json`) carry a steps hash, so edits after a green run go stale |
| `forge defer add\|resolve\|list` | Deferred wiring as tracked debt in the session |
| `forge integrity-check` | Combined gate — also run automatically by `forge phase done\|finish` |

Defaults (`integrity.forbidStubs`, `specsBeatNarrowTasks`, `requireE2E`) live in
`preferences.defaults.json` and appear in `forge status`.

Escape hatch: `forge phase done --allow-incomplete "<reason>"` records an honest
exception in the session — it does not silently checkbox past gaps.

### Task gates (opt-in)

Optional per-group executable checks, off by default
(`.forge/config.json` → `gates.enabled: true`). `forge gate init` scaffolds
`gates.json` (one entry per `tasks.md` `##` group) in the change dir; fill
each group's `check` (command) and `expect` (regex). `forge gate check
[--group <id>]` runs them and records session `gate-results.json`; `forge
gate status` reports `met | unmet | stale | no-run | no-check` per group.
Once every task is complete, `forge integrity-check` requires a green,
current result for every group with a check — partial progress never gates.

### What runs automatically every session

You do **not** paste a long definition-of-done prompt. After
`forgekit install --skills forge`, every Forge session gets:

| Automatic (CLI / hooks) | Agent-driven (skill phases — required) |
| ----------------------- | -------------------------------------- |
| Integrity reminder on every session/prompt hook | Plan: **`forge spine init` every change** — fill rows or `notApplicable`; rows → also `forge e2e init` |
| Pace `auto` fail-closed to **standard**; task-count escalation at ≥15 | Implement: update spine rows; `forge defer add` if wiring is deferred |
| `forge phase done\|finish` requires valid spine + green current e2e run + writes L2 scorecard | Verify: green `forge e2e run` when spine has rows (sync-only → prefer `notApplicable`) |
| `forge status` surfaces `integrity.*` defaults | After done: answer L3 ship-check in `scorecard.md` |

**Gates are automatic. Filling evidence is part of the normal phase flow.**
Skipping those steps fails at `forge phase done`, not silently.

### Worked example (jobs / workers change)

**Plan**

```bash
forge spine init
# edit openspec/changes/<name>/spine.json — one row per capability
```

```json
{
  "change": "etl-surveydb-pipeline-closure",
  "notApplicable": null,
  "rows": [
    {
      "capability": "REQ-GOV-01 matching",
      "library": "services/etl-core/src/etl_core/matcher.py",
      "runtimeOwner": "worker job analyze_study",
      "writes": "study_proposals",
      "reads": "N/A",
      "uiConsumer": "Proposals page",
      "evidence": "tasks/12-analyze/test-evidence.md"
    },
    {
      "capability": "REQ-OUT-BI star schema",
      "library": "services/etl-core/src/etl_core/bi_star.py",
      "runtimeOwner": "worker job harmonization_run",
      "writes": "runs/<id>/bi/*.parquet",
      "reads": "decisions tip + weight_map tips",
      "uiConsumer": "Runs artifact download",
      "evidence": "verify-evidence.md#product-loop"
    }
  ]
}
```

Docs-only / no-runtime changes may set `"notApplicable": "docs-only change"` instead of rows.

Spine rows → also author the executable acceptance steps:

```bash
forge e2e init
# edit openspec/changes/<name>/e2e.json — the closed loop as commands
```

```json
{
  "change": "etl-surveydb-pipeline-closure",
  "notApplicable": null,
  "steps": [
    { "name": "ingest", "cmd": "node scripts/e2e/ingest-fixture.mjs OP1086" },
    { "name": "analyze", "cmd": "node scripts/e2e/run-analyze.mjs", "expect": "proposals: [1-9]" },
    { "name": "ratify", "cmd": "node scripts/e2e/ratify-subset.mjs" },
    { "name": "run-assert", "cmd": "node scripts/e2e/assert-output-differs.mjs", "timeoutMs": 600000 }
  ]
}
```

Steps must assert domain side effects — a list that would pass against a
stubbed handler is invalid. `"notApplicable": "<reason>"` only when no command
can drive the loop.

**If wiring must wait for a later task**

```bash
forge defer add --task 9.7 --reason "analyze_study handler lands in 9.7"
# … when 9.7 is done:
forge defer resolve --task 9.7
```

**Verify** (required when spine has rows):

```bash
forge e2e run    # executes the steps, writes e2e-results.json (session dir)
```

Green run required; results go stale if `e2e.json` changes afterwards (steps
hash). Keep a short loop narrative under `## Product loop` in
`verify-evidence.md` as reviewer context — the gate checks the executed
results, not the heading.

Or an explicit `BLOCKED: …` line in `verify-evidence.md` — then `forge phase
done` refuses until unblocked or the user passes `--allow-incomplete`.

**Finish**

```bash
forge integrity-check   # optional preview
forge phase done        # same checks; exit 1 if incomplete
```

---

## Subagent model

The unit of dispatch is a **work unit** — by default one `tasks.md` group, at
most 4 tasks, and always 1:1 for money/auth/contracts/migrations. Each unit:

1. Coordinator writes the unit's `brief.md` (every task's text + file paths + constraints — **no chat history**).
2. **Implementer** subagent — must follow `skills/test-driven-development` first, one task at a time, red→green stamps per task.
3. **Task reviewer** subagent (spec then quality) — unless pace skips low-risk work — reading the unit's **diff range**, not the repository.
4. Mark each finished task complete (`tasks.md` checkbox or session progress).
5. After all tasks: **verify** (tier 3 scope from pace; leftover sweep: `spec-verify.md` always on for specs, `openspec-verify.md` when `openspec-verify-change` is present) → **final reviewer** (unless pace skips; dispatch it with the Task description exactly what `forge review-label final` prints, which also stamps the dispatch into `reviews/dispatches.json` so the evidence survives host-transcript pruning — see [phases/review.md](../phases/review.md)) → finish.

Test tiers: [test-strategy.md](../references/test-strategy.md) — scoped TDD per task, narrow evidence per task, full workspace **once** at verify when pace requires it (not every task).

### Model selection (capability × billing)

**Canonical rules (agents must follow):** [model-selection.md](../references/model-selection.md).

Subagents resolve models through **two axes** so Cursor / Claude Code / Codex stay on **subscription/included** pools by default. You choose only the **tier**; the resolver chooses the slug (or omit):

| Axis | Values | Default |
| ---- | ------ | ------- |
| Capability | `fast` · `standard` · `capable` | role-based |
| Billing | `included` · `metered` | **`included`** |

```bash
forge resolve-model --tier standard   # JSON: { model, omitModel, billing, … }
forge models                          # print effective billing (no file write)
forge models metered                  # WRITE .forge/models.local.json
```

- Defaults: `packages/cli/src/models.defaults.json` (Cursor `included` = `inherit` → omit Task `model`).
- Local overlay is optional — see **Checkout-local overrides** above.
- **Always follow the resolver JSON.** Never invent host model slugs; never pick from the host’s available-models list.
- **`omitModel: true` → omit the `model` parameter entirely.** Passing any named slug (e.g. a Claude/GPT/Composer id from the Task tool enum) overrides inherit and can **bill the user** — forbidden unless the resolver returned that exact slug with `omitModel: false`.
- A Claude Code project may **enforce** the overlay at dispatch time
  (`forge enforce-model`, wired as a `PreToolUse` hook by `forge init --claude`).
  A lane whose three tiers are one model rewrites the dispatch; a lane that keeps
  tiers apart denies a model outside the resolved three. A denial means resolve
  and re-dispatch — not retry the same model. Without `.forge/models.local.json`
  the hook allows everything.
- Escalate **capability** within `included` on `BLOCKED`; switch to `metered` only on explicit user request.
- Keep the **parent** session on Auto/Composer (Cursor) or Max (Claude Code) — `inherit` follows the parent.

Guardrails in every subagent brief (honor the **project’s** agent docs too):

- No autonomous `git commit` / push unless the user asks — subagents never commit at all
- Implementer runs tier 1 (scoped) + tier 2 (narrow) tests; coordinator saves `tasks/<nn>-<slug>/test-evidence.md` before marking task done
- Trace downstream consumers when contracts change

Prompt templates: [subagents/](../subagents/)

---

## Checkpoints (opt-in commits)

Off by default. Enable per project in `.forge/config.json`:

```json
{ "git": { "checkpoint": "per-group" } }
```

| Mode | When the coordinator runs `forge checkpoint` |
| ---- | -------------------------------------------- |
| `off` (default) | never — nothing is committed, reviewers read the working tree |
| `per-group` | at each `tasks.md` group boundary |
| `per-task` | after each task |

Why: a long session otherwise accumulates the whole change as one uncommitted
working tree — one bad `git checkout` from losing a day of agent work, with
every reviewer after task 1 reading a diff that contains all previous tasks.

Guarantees — the reason this is safe to automate:

- **Never pushes.** Nothing leaves the machine.
- **Refuses on the default branch** (`main` / `master`) unless
  `--allow-default-branch` or `git.allowDefaultBranch: true`.
- **Refuses mid-merge / rebase / cherry-pick / revert / bisect.**
- **Excludes `.forge/`** — session scratch never lands in project history.
- **Refuses foreign untracked change dirs** — untracked paths under
  `<plan.dir>/changes/<other>/` (not this session's `openspecChange`, not
  `archive/`) block the checkpoint with a listed refuse; they are not swept
  into this change's commit.
- Nothing to commit is success, not an error, and never makes an empty commit.
- Records `{ sha, group, tasks, at }` on the session, so reviewers get a real
  range: `groupRange` (this group) and `range` (whole session, from
  `session.baseCommit`, which `forge new` records even when checkpoints are off).

```bash
forge checkpoint --group 06-helm-cli --tasks 6.1-6.4
forge checkpoint --dry-run          # list what would be committed
forge checkpoint --range --last     # {DIFF_RANGE} for the group reviewer
```

**Reviewer scope.** A group review happens *before* that group's checkpoint,
so HEAD is still the previous one and a `<base>..HEAD` range would be empty.
Use the `reviewTarget` field from `forge checkpoint --range --last`:

| Tree state | `reviewTarget` |
| ---------- | -------------- |
| group still uncommitted | `git diff <last checkpoint>` **plus** the untracked files listed by name — `git diff` never shows them, and new files are most of what an implementer writes |
| group checkpointed | `<last checkpoint>..HEAD` |

`range` in the same output is the commit range only; it is empty mid-group by
design. `--last` scopes to the current group, without it the base is
`session.baseCommit` (the whole session).

Caveat: a checkpoint still stages tracked edits and untracked files outside
`.forge/` (including new package files). It will **not** silently include
another change's untracked `<plan.dir>/changes/<other>/` tree — that refuses
with a path list. Check `--dry-run` when the working tree was not clean before
the session started.

---

## Session health

`forge status` returns a verdict next to the data, and the reminder hook
surfaces it on resume when it is not healthy:

| State | Meaning |
| ----- | ------- |
| `red` | e2e run failing (named step), or `verify-evidence.md` records BLOCKED |
| `stale` | no session activity for `health.idleHours` (default 4) — activity is `max(session.updatedAt, linked tasks.md mtime)` — or e2e results no longer match `e2e.json`. Task progress for openspec/specs sessions is derived from `tasks.md` checkboxes (session cache is healed on status/fleet/reminder). |
| `healthy` | none of the above |
| `done` | phase `done` / `skipped` |

`forge fleet list` renders the same verdict as a HEALTH column plus a reason
line per unhealthy session, so a red or abandoned session is visible without
opening the project.

---

## Bundled skills (self-contained)

Forge vendors adapted Superpowers skills (MIT) under `skills/forge/skills/`.
See [skills/NOTICE.md](../skills/NOTICE.md).

| Skill | Purpose |
| ----- | ------- |
| brainstorming | Brainstorm phase |
| test-driven-development | Implement — per task |
| subagent-driven-development | Implement — orchestration |
| systematic-debugging | Blockers during implement |
| verification-before-completion | Verify phase |
| requesting-code-review | Review phase |

The bundled skills are a **maintained fork** of Superpowers (MIT — see `skills/NOTICE.md`), restructured for Forge (single task reviewer, tiered testing, trimmed prose). Do not re-vendor from upstream; edit `skills/forge/` in this repo and run `forgekit install --skills forge --force`.

## Relationship to OpenSpec

| Piece | Source | Policy |
| ----- | ------ | ------ |
| Brainstorm, TDD, subagents, verify, review | **skills/forge/skills/** (bundled) | Self-contained; Superpowers plugin not required |
| Planning sink | OpenSpec or built-in specs engine | Engine per project (`.forge/config.json`); no throwaway or direct modes for new work |
| OpenSpec skills | Vendor (`openspec-*`, `opsx:*`) | **Do not hand-edit** — run `forge overlay` after upgrade |
| OpenSpec implement | Forge **`/forge:apply`** | Full subagent TDD + verify + leftover sweep + review; survives OpenSpec upgrades |
| OpenSpec verify | Vendor `openspec-verify-change` / `/opsx:verify` | Run at end of Forge verify when present; fix every finding, save `openspec-verify.md`, then final review |
| Specs verify | Bundled `specs-verify-change` | Always on for `planType: specs`; fix every finding, save `spec-verify.md`, then final review |
| Archive follow-up | Optional ADRs (`forge init --adr`) | When `.forge/config.json` has `adr.enabled`, run **archive-to-adr** (path from `adr.dir`, default `docs/adr`) |

---

## Agent surfaces

Same workflow across Cursor, Claude Code, and Codex CLI. Install the skill once
per machine with `forgekit install`; wire project commands/hooks with `forge init`.

| Agent | Skill (after install) | Project wiring (`forge init`) | Session hooks |
| ----- | --------------------- | ----------------------------- | ------------- |
| **Cursor** | `~/.agents/skills/forge/` (pick that harness) | commands, `forge.mdc`, SessionStart hook (`forge init --cursor`) | SessionStart → active session reminder |
| **Claude Code** | `~/.agents/skills/forge/` via symlink at `~/.claude/skills/forge/` | commands, `forge.md`, SessionStart + prompt hooks | SessionStart + `/forge` or “use Forge” UserPromptSubmit; Stop hook completion backstop (`hooks.stopGate: "off"` to disable) |
| **Codex CLI** | `~/.agents/skills/forge/` (pick that harness) | thin rule | *(none — start only when the user asks to use Forge)* |
| **Copilot / Gemini / OpenCode** | `~/.agents/skills/forge/` (pick that harness; one dest) | *(none — global skill only)* | *(none — start only when the user asks to use Forge)* |
| **Windsurf** | `~/.agents/skills/forge/` via vendor-path symlink | *(none — global skill only)* | *(none — start only when the user asks to use Forge)* |

### Slash commands (Cursor + Claude Code)

| Command | Purpose |
| ------- | ------- |
| `/forge` | Start or resume current phase |
| `/forge:brainstorm` | Brainstorm only |
| `/forge:plan` | Tracked-change propose (engine from `.forge/config.json`) |
| `/forge:apply` | Tracked-change implement + verify + review (preferred) |
| `/forge:build` | Implement phase (`tasks.md` from either engine) |
| `/forge:status` | Session progress |
| `/forge:harness` | Ensure a working, recorded project e2e harness |
| `/forge:analyze` | Improvement report over recent sessions |
| `/forge:skip` | Explicit skip for this task |

### Codex CLI

No slash commands. Start Forge only when the user asks to **use Forge** (or types `/forge` in the prompt). Then triage is Step 0 — read the **`forge`** skill, check
`forge status`, bootstrap with `forge new <slug>` when the work is substantial.
After brainstorm, proceed directly to the configured engine's propose flow — see
[plan-routing.md](../references/plan-routing.md).
User can say “skip forge” or `/forge:skip` to opt out.

### Vendor-neutral `.agents` target

`.agents` is not a picker item. Selecting any harness writes the skill once
to `~/.agents/skills/forge/`. Cursor, Codex, Copilot, Gemini, and OpenCode
discover that root natively. Claude Code and Windsurf get a directory
symlink from their vendor skill path to the same folder. There is no
`--shared` flag. Claude still needs `--claude` so the symlink is created.
`forge init --agents` errors and points at `forgekit install`. Leftover
stamped project copies at `.agents/skills/forge/` (from 0.3.48) are warned
by `forge doctor` and retired by the next `forge init`; unstamped / other
`.agents/` content is left alone. In agnostic tools, invoke Forge **by name**
(“use Forge”, “do forge work”).

---

## What we deliberately dropped from Superpowers

- `docs/superpowers/plans/` and `docs/superpowers/specs/` — use OpenSpec / `specs/changes/` + `.forge` (the built-in specs engine covers the no-OpenSpec case with an OpenSpec-compatible layout)
- Mandatory git worktree per brainstorm — optional
- Autonomous commits in subagent prompts — forbidden unless the user asks
