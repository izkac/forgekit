# Forge — disciplined development workflow

Forge is an **OpenSpec-native**, **self-contained** development pipeline.
All workflow skills (brainstorm, TDD, subagents, verify, review) live under the
Forge skill’s `skills/` folder — **no Superpowers plugin required**.

**Skill:** `forge` (Cursor, Claude Code, Codex CLI)  
**Commands:** `/forge`, `/forge:*` (after `forge init`; Cursor and Claude Code)  
**Scratch space:** `.forge/` (gitignored except README)  
**CLI:** `@forgekit/cli` → `forgekit` (install) · `forge` (workflow) · `review` (standalone deep review)

---

## Install

```bash
# Once per machine (from forgekit checkout or published package)
npm link --workspace=@forgekit/cli   # or: npm i -g @forgekit/cli when published
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
                          │
                          ▼
         Final review (pace) + verification-before-completion
                          │
                          ▼
                 /opsx:archive (+ project ADR follow-up if any)
                          │
                          ▼
            Done + cleanup .forge session
```

### Triage (top of tree)

| Check | Outcome |
| ----- | ------- |
| User sent `/forge:skip` | Direct execution |
| Not substantial / not OpenSpec-worthy | Direct execution |
| Otherwise | Enter Forge session (OpenSpec) |

### Planning (after brainstorm)

Forge **always** uses OpenSpec. Proceed directly to `/opsx:propose` — do not ask for a plan mode.

| Step | What happens |
| ---- | ------------ |
| **OpenSpec propose** | `/opsx:propose` → `openspec/changes/<name>/` |
| **User approval** | Confirm proposal, design, tasks before implement |
| **Implement** | `/forge:apply` or `/forge:build` against `tasks.md` |

See the Forge skill’s [references/plan-routing.md](../skills/forge/references/plan-routing.md).

---

## Phases

| Phase | What happens | Skills / commands |
| ----- | ------------ | ----------------- |
| **triage** | Substantial? Skip allowed? Bootstrap session | `forge` skill |
| **brainstorm** | Explore intent, approaches, approval | `skills/brainstorming` |
| **plan** | OpenSpec propose — `/opsx:propose` → `openspec/changes/<name>/` | [plan-routing.md](../skills/forge/references/plan-routing.md) |
| **implement** | Subagent per task, TDD, tier 2 evidence | **`/forge:apply`** (OpenSpec) or `/forge:build` + `skills/subagent-driven-development` + `skills/test-driven-development` + [test-strategy](../skills/forge/references/test-strategy.md) |
| **verify** | Audit tier 2 evidence; **one tier 3 full-workspace run** (per pace) | `skills/verification-before-completion` + `verify-evidence.md` |
| **review** | Combined task reviewer (spec + quality) per task; final review | `skills/requesting-code-review` |
| **finish** | Archive (+ ADR if the project uses that), cleanup session | `/opsx:archive`, `forge cleanup` |

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
      verify-evidence.md              ← tier 3 full workspace (verify phase)
      tasks/
        01-first-task/
          brief.md
          test-evidence.md
          task-review.md              ← combined spec + quality verdict
      reviews/
        final-review.md
```

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
| `/forge:plan` | Plan phase — OpenSpec propose (`/opsx:propose`) |
| `/forge:apply` | **OpenSpec implement** — subagent TDD + verify + review (preferred over `/opsx:apply`) |
| `/forge:build` | Implement phase (OpenSpec tasks) |
| `/forge:status` | Show active session progress |
| `/forge:skip` | **Explicit** opt-out of Forge for this task |

OpenSpec commands remain available standalone:

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
forge doctor                      # OpenSpec project + CLI readiness
forge doctor --install            # attempt npm install -g @fission-ai/openspec
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

| Concern | Defaults (in `@forgekit/cli`) | Local file (gitignored) | Get (print only) | Set (creates/updates file) |
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
2. ecosystem / API / multi-file / shared package → **standard**
3. docs / typo / rename / scaffold → **lite**
4. else → **brisk**

**Unchanged on all paces:** tier-1 TDD + tier-2 evidence, no autonomous commit, OpenSpec when in Forge.

Agent rules for each knob: [pace.md](../skills/forge/references/pace.md).

Prefs are gitignored (`.forge/preferences.local.json`), same pattern as `models.local.json`.

### OpenSpec doctor

`forge doctor` checks `openspec/config.yaml` and that `openspec` is on PATH.
If the CLI is missing, it warns and offers `npm install -g @fission-ai/openspec`
(`--install` to attempt). `forge new` runs doctor warn-only so a missing CLI does
not block session creation.

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
| Planning sink | OpenSpec only | `/opsx:propose` → `openspec/changes/`; no throwaway or direct modes for new work |
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
| `/forge:plan` | OpenSpec propose — `/opsx:propose` |
| `/forge:apply` | OpenSpec implement + verify + review (preferred) |
| `/forge:build` | Implement phase (OpenSpec tasks) |
| `/forge:status` | Session progress |
| `/forge:skip` | Explicit skip for this task |

### Codex CLI

No slash commands. On substantial work: read the **`forge`** skill, check
`forge status`, bootstrap with `forge new <slug>` when needed.
After brainstorm, proceed directly to **OpenSpec** (`/opsx:propose`) — see
[plan-routing.md](../skills/forge/references/plan-routing.md).
User can say “skip forge” or `/forge:skip` to opt out.

---

## What we deliberately dropped from Superpowers

- `docs/superpowers/plans/` and `docs/superpowers/specs/` — use OpenSpec + `.forge`
- Mandatory git worktree per brainstorm — optional
- Autonomous commits in subagent prompts — forbidden unless the user asks
