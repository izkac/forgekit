# Forge — disciplined development workflow

Forge is an **OpenSpec-native**, **self-contained** development pipeline.
All workflow skills (brainstorm, TDD, subagents, verify, review) live under the
Forge skill’s `skills/` folder — **no Superpowers plugin required**.

It does not stop at green unit tests or checked-off tasks: **runtime integrity**
requires a named production path for every claimed capability, and (for
jobs/workers) a closed product loop before `forge phase done`. See
[Runtime integrity](#runtime-integrity).

**Using Forgekit for the first time?** Start with the tutorial:
[**How to use Forgekit**](usage.md) (install → init → `/forge:apply` → examples).

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
            │  PER TASK (loop until done) │
            │  1. Subagent implementer  │
            │  2. TDD (scoped tests)    │
            │  3. Reviewer (pace):      │
            │     thorough=per task     │
            │     standard=per group    │
            │     └─ fail ──► retry     │
            │  (tier 2 narrow evidence) │
            └─────────────┬─────────────┘
                          ▼
         Verify: audit tier 2 + tier 3 (scope from pace)
                  + ## Product loop (or BLOCKED)
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

**Jobs / workers / queues:** during Plan, also run `forge spine init` and keep
`spine.json` wired through Implement. See [Runtime integrity](#runtime-integrity)
below.

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
| `specs` | `specs/changes/<name>/` (dir from `plan.dir`) | Built-in — plain markdown, same layout |

Selection flow: `forgekit install` asks once for a user default
(`~/.forgekit/config.json` → `plan.engine`); `forge init` auto-detects
(`openspec/config.yaml` present → openspec, silent), otherwise offers to
install + `openspec init`, and falls back to the specs engine on decline
(`--openspec` / `--no-openspec` skip prompts). Migration later: `openspec
init`, then move `specs/changes/*` into `openspec/changes/`.

### Planning (after brainstorm)

Proceed directly to the configured engine's propose flow — do not ask for a plan mode.

| Step | What happens |
| ---- | ------------ |
| **Propose** | `/opsx:propose` → `openspec/changes/<name>/` (openspec) or author `specs/changes/<name>/{proposal,tasks}.md` per [plan-specs.md](../skills/forge/phases/plan-specs.md) (specs) |
| **User approval** | Confirm proposal, design, tasks before implement |
| **Implement** | `/forge:apply` or `/forge:build` against `tasks.md` |

See the Forge skill’s [references/plan-routing.md](../skills/forge/references/plan-routing.md).

---

## Phases

| Phase | What happens | Skills / commands |
| ----- | ------------ | ----------------- |
| **triage** | Substantial? Skip allowed? Bootstrap session | `forge` skill |
| **brainstorm** | Explore intent, approaches, approval | `skills/brainstorming` |
| **plan** | Tracked-change propose; orchestration seam + `forge spine init` when jobs/workers | [plan-routing.md](../skills/forge/references/plan-routing.md) |
| **implement** | Subagent per task, TDD, tier 2 evidence; update spine rows; `forge defer` for deferred wiring | **`/forge:apply`** (OpenSpec) or `/forge:build` + `skills/subagent-driven-development` + `skills/test-driven-development` + [test-strategy](../skills/forge/references/test-strategy.md) |
| **verify** | Audit tier 2; tier 3; product-loop evidence; `forge integrity-check` | `skills/verification-before-completion` + `verify-evidence.md` |
| **review** | Combined task reviewer (spec + quality) per task; final review (spine + product loop) | `skills/requesting-code-review` |
| **finish** | Archive (+ ADR if the project uses that); `forge phase done` (integrity gate); cleanup | `/opsx:archive`, `forge cleanup` |

**Standalone deep review (outside Forge):** for pre-merge audits with adversarial false-positive filtering, use the **thorough code review** skill — see [`docs/thorough-code-review.md`](thorough-code-review.md). Forge's `requesting-code-review` stays the per-task checkpoint during `/forge:build`.

---

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
      session.json                    ← phase, planType, openspecChange, pace
      status.json                     ← machine-readable progress
      brainstorm/
        notes.md
        decisions.md
      plan.md                         ← legacy throwaway plans only (deprecated)
      verify-evidence.md              ← tier 3 + ## Product loop (or BLOCKED)
      deferrals.json                  ← forge defer registry (when used)
      spine.json                      ← fallback if no tracked change dir
      tasks/
        01-first-task/
          brief.md
          test-evidence.md
          task-review.md              ← combined spec + quality verdict
      reviews/
        final-review.md
```

For OpenSpec / specs-engine changes, the canonical **spine matrix** lives next to
the plan: `openspec/changes/<name>/spine.json` (or `<specsDir>/changes/<name>/spine.json`).

**Session ID:** `<UTC-compact>-<kebab-slug>-<6-hex>`

**Retention:** 14 days. Finished sessions (`phase: done|skipped`) are removed
on cleanup. Active session is never removed unless `--include-active`.

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
forge status                      # active session JSON (+ effective pace)
forge phase <phase> […]           # update phase / openspec / task counters
forge cleanup [--dry-run]         # prune sessions >14 days or finished
forge evidence --task <nn>-<slug> --command "<cmd>" --exit 0 --summary "<text>"
                                  # stamp tier-2 test-evidence.md
forge resolve-model --tier <fast|standard|capable>
                                  # JSON model resolution (included billing by default)
forge models                      # print effective billing (does NOT write a file)
forge models included|metered     # WRITE .forge/models.local.json
forge prefs                       # print effective pace (does NOT write a file)
forge prefs auto|thorough|standard|brisk|lite
                                  # WRITE .forge/preferences.local.json
forge prefs --session-set lite    # pin active session only
forge doctor                      # plan-engine readiness (OpenSpec or specs layout)
forge doctor --install            # attempt npm install -g @fission-ai/openspec
forge spine init|check            # capability→runtime spine matrix (spine.json in change dir)
forge defer add|resolve|list      # deferral registry — deferred wiring is tracked debt
forge integrity-check             # mechanical gate: spine + deferrals + product-loop evidence
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
depth) is controlled by a **pace** preset. Default is **`auto`**: resolve once at
session start from risk signals, sticky for the session.

| Pace | Intent |
|------|--------|
| `auto` | Pick thorough / standard / brisk / lite from signals (default) |
| `thorough` | Always review **each task**; full-workspace tier 3 |
| `standard` | Review once per **OpenSpec group**; full-workspace tier 3 |
| `brisk` | Review high-risk tasks only; affected-workspace tier 3 |
| `lite` | Skip reviews for low-risk; audit tier-2 only at verify |

### Effort matrix (exact knobs)

Defaults from `packages/cli/src/preferences.defaults.json`:

| Knob | `thorough` | `standard` | `brisk` | `lite` |
|------|------------|------------|---------|--------|
| **review.perTask** | always | per-group | high-risk-only | never\* |
| **review.final** | always | always | high-risk-only | never\* |
| **review.depth** | full | full | spec-only | spec-only |
| **review.maxRounds** | 3 | 2 | 1 | 0 |
| **verify.tier3** | full-workspace | full-workspace | affected-only | audit-tier2-only |
| **models.bias** | default | default | prefer-fast | prefer-fast |
| **brainstorm.depth** | full | full | short (≤2–3 options) | minimal |

\*Hard floor: money / auth / contracts / migrations / secrets still get per-task review (and final if the session touched high-risk), even under `brisk` / `lite` / mid-group `standard`.

**`thorough` vs `standard`:** thorough reviews every task; standard reviews once per OpenSpec `tasks.md` group (`##` section), except high-risk tasks which still get an immediate per-task review.

**`auto`** is not a preset — it picks one of the four once at session start (sticky):

1. money / payment / auth / secret / migration / contract / gdpr → **thorough**
2. ecosystem / API / multi-file / shared package / worker / job queue / pipeline / etl / platform / orchestration / openspec → **standard**
3. docs / typo / rename / scaffold / changelog → **lite**
4. fix / tweak / toolbar / style / padding (explicitly small) → **brisk**
5. else (including empty / unrecognized) → **standard** (fail closed)

When `--tasks-total N` is set with **N ≥ 15** and resolved pace is still `brisk`/`lite` (not user-pinned), Forge escalates the session to **standard**.

**Unchanged on all paces:** tier-1 TDD + tier-2 evidence, no autonomous commit, OpenSpec when in Forge. Runtime integrity (below) applies at every pace.

Agent rules for each knob: [pace.md](../skills/forge/references/pace.md).

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
[runtime-integrity.md](../skills/forge/references/runtime-integrity.md) and are
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
5. **E2E = product loop** — produce → consume → decision changes output. A single job slice (ingest → Parquet) is **not** platform E2E.
6. **Job-kind closure** — every product-surface job kind is wired end-to-end **or deleted** before complete. “Fail closed” is only a temporary `BLOCKED` state.
7. **Consumer–producer** — if UI/API reads it, production must write it (proven in evidence).
8. **Deferrals are tracked** — “wiring later” only via `forge defer`; unresolved deferrals block `done`.

### Mechanics

| Tool | Purpose |
|------|---------|
| `forge spine init\|check` | Per-change `spine.json`: capability → library → runtime owner → writes → reads → UI → evidence |
| `forge defer add\|resolve\|list` | Deferred wiring as tracked debt in the session |
| `forge integrity-check` | Combined gate — also run automatically by `forge phase done\|finish` |

Defaults (`integrity.forbidStubs`, `specsBeatNarrowTasks`, `requireE2E`) live in
`preferences.defaults.json` and appear in `forge status`.

Escape hatch: `forge phase done --allow-incomplete "<reason>"` records an honest
exception in the session — it does not silently checkbox past gaps.

### What runs automatically every session

You do **not** paste a long definition-of-done prompt. After
`forgekit install --skills forge`, every Forge session gets:

| Automatic (CLI / hooks) | Agent-driven (skill phases — required) |
| ----------------------- | -------------------------------------- |
| Integrity reminder on every session/prompt hook | Plan: `forge spine init` + fill rows when jobs/workers |
| Pace `auto` fail-closed to **standard**; task-count escalation at ≥15 | Implement: update spine rows; `forge defer add` if wiring is deferred |
| `forge phase done\|finish` runs `integrity-check` and refuses on failure | Verify: `## Product loop` in `verify-evidence.md` (or `BLOCKED`) |
| `forge status` surfaces `integrity.*` defaults | Reviewers REJECT unregistered deferrals / library-only spine rows |

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

**If wiring must wait for a later task**

```bash
forge defer add --task 9.7 --reason "analyze_study handler lands in 9.7"
# … when 9.7 is done:
forge defer resolve --task 9.7
```

**Verify evidence** (required when spine has rows):

```markdown
# Verify evidence — tier 3

- **Command:** `pytest …` / `npm test …`
- **Exit code:** 0

## Product loop

Fixture: OP1086 three sources

1. ingest_source ×3 → study_sources + Parquet
2. analyze_study → study_proposals (match / loop)
3. ratify subset via API → decisions tip at revision R
4. harmonization_run @R → .sav + Master QML + BI
5. Assert: output at R differs from unratified baseline
```

Or an explicit `BLOCKED: …` line — then `forge phase done` refuses until unblocked
or the user passes `--allow-incomplete`.

**Finish**

```bash
forge integrity-check   # optional preview
forge phase done        # same checks; exit 1 if incomplete
```

---

## Subagent model

Each implementation task:

1. Coordinator writes `tasks/<nn>-<slug>/brief.md` (task text + file paths + constraints — **no chat history**).
2. **Implementer** subagent — must follow `skills/test-driven-development` first.
3. **Task reviewer** subagent (spec then quality) — unless pace skips low-risk tasks.
4. Mark task complete (`tasks.md` checkbox or session progress).
5. After all tasks: **verify** (tier 3 scope from pace) → **final reviewer** (unless pace skips) → finish.

Test tiers: [test-strategy.md](../skills/forge/references/test-strategy.md) — scoped TDD per task, narrow evidence per task, full workspace **once** at verify when pace requires it (not every task).

### Model selection (capability × billing)

Subagents resolve models through **two axes** so Cursor / Claude Code / Codex stay on **subscription/included** pools by default:

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
- **Never invent** host model slugs; honor `omitModel` / `model` from the resolver.
- Escalate **capability** within `included` on `BLOCKED`; switch to `metered` only on explicit user request.
- Keep the **parent** session on Auto/Composer (Cursor) or Max (Claude Code) — `inherit` follows the parent.

Guardrails in every subagent brief (honor the **project’s** agent docs too):

- No autonomous `git commit` / push unless the user asks
- Implementer runs tier 1 (scoped) + tier 2 (narrow) tests; coordinator saves `tasks/<nn>-<slug>/test-evidence.md` before marking task done
- Trace downstream consumers when contracts change

Prompt templates: [skills/forge/subagents/](../skills/forge/subagents/)

---

## Bundled skills (self-contained)

Forge vendors adapted Superpowers skills (MIT) under `skills/forge/skills/`.
See [skills/NOTICE.md](../skills/forge/skills/NOTICE.md).

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
| OpenSpec implement | Forge **`/forge:apply`** | Full subagent TDD + verify + review; survives OpenSpec upgrades |
| Archive follow-up | Optional ADRs (`forge init --adr`) | When `.forge/config.json` has `adr.enabled`, run **archive-to-adr** (path from `adr.dir`, default `docs/adr`) |

---

## Agent surfaces

Same workflow across Cursor, Claude Code, and Codex CLI. Install the skill once
per machine with `forgekit install`; wire project commands/hooks with `forge init`.

| Agent | Skill (after install) | Project wiring (`forge init`) | Session hooks |
| ----- | --------------------- | ----------------------------- | ------------- |
| **Cursor** | `~/.cursor/skills/forge/` | commands, `forge.mdc`, SessionStart hook | SessionStart → active session reminder |
| **Claude Code** | `~/.claude/skills/forge/` | commands, `forge.md`, SessionStart + prompt hooks | SessionStart + substantial-work UserPromptSubmit + `/forge` UserPromptSubmit |
| **Codex CLI** | `~/.codex/skills/forge/` | thin rule | *(none — read skill on substantial work)* |

### Slash commands (Cursor + Claude Code)

| Command | Purpose |
| ------- | ------- |
| `/forge` | Start or resume current phase |
| `/forge:brainstorm` | Brainstorm only |
| `/forge:plan` | Tracked-change propose (engine from `.forge/config.json`) |
| `/forge:apply` | Tracked-change implement + verify + review (preferred) |
| `/forge:build` | Implement phase (`tasks.md` from either engine) |
| `/forge:status` | Session progress |
| `/forge:skip` | Explicit skip for this task |

### Codex CLI

No slash commands. On substantial work: read the **`forge`** skill, check
`forge status`, bootstrap with `forge new <slug>` when needed.
After brainstorm, proceed directly to the configured engine's propose flow — see
[plan-routing.md](../skills/forge/references/plan-routing.md).
User can say “skip forge” or `/forge:skip` to opt out.

---

## What we deliberately dropped from Superpowers

- `docs/superpowers/plans/` and `docs/superpowers/specs/` — use OpenSpec / `specs/changes/` + `.forge` (the built-in specs engine covers the no-OpenSpec case with an OpenSpec-compatible layout)
- Mandatory git worktree per brainstorm — optional
- Autonomous commits in subagent prompts — forbidden unless the user asks
