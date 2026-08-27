---
name: forge
description: >-
  Forge — self-contained disciplined development workflow. Brainstorm, tracked
  plan, subagent-driven TDD, verify, review, and finish.
  Use when the user invokes /forge or asks for Forge by name ("use Forge",
  "do forge work", "with the forge workflow"). Triage is always the first step
  after invoke. Do not start Forge on uninvoked requests.
disable-model-invocation: true
---

# Forge

Spec-tracked development pipeline. Planning engine is per-project
(`.forge/config.json` → `plan.engine`): **OpenSpec** (vendor CLI) or the
**built-in specs engine** (`specs/changes/`, same layout). **Self-contained** —
all workflow skills live under `./skills/` (vendored from Superpowers MIT; see
[skills/NOTICE.md](./skills/NOTICE.md)).

Full reference: [docs/forge.md](./docs/forge.md) (ships with this skill).

**Announce at start:** "Using Forge for this work." Include effective pace from
`forge status` (e.g. `Pace: auto → brisk (…)`) — see [references/pace.md](./references/pace.md).

## Instruction priority

1. User explicit instructions (including `/forge:skip` and pace overrides)
2. This skill + `./phases/`, `./references/`, and `./skills/`
3. Project OpenSpec skills (`openspec-propose`, `openspec-apply-change`) — do not edit vendor copies (OpenSpec-engine projects only)

## Pace (thoroughness)

Checkout-local prefs control review/verify ceremony. Default pace is **`auto`**
(resolves once per session from risk signals).

```bash
forge prefs                         # print effective pace (does NOT write a file)
forge prefs brisk                   # WRITE .forge/preferences.local.json
forge prefs --session-set lite
forge models                        # print billing (does NOT write); set: included|metered
forge doctor                        # plan-engine readiness (OpenSpec CLI or specs/ layout)
```

Honor [references/pace.md](./references/pace.md) in implement / verify / review.
Hard floor: money/auth/contracts/migrations always get per-task review (even under `standard` mid-group / `brisk` / `lite`).
Local overlays: [docs/forge.md](./docs/forge.md) § Checkout-local overrides.

## Bundled skills

| Skill | Path | When |
| ----- | ---- | ---- |
| Brainstorming | [skills/brainstorming/SKILL.md](./skills/brainstorming/SKILL.md) | brainstorm phase |
| TDD | [skills/test-driven-development/SKILL.md](./skills/test-driven-development/SKILL.md) | every implement task |
| Subagent-driven dev | [skills/subagent-driven-development/SKILL.md](./skills/subagent-driven-development/SKILL.md) | implement phase |
| Systematic debugging | [skills/systematic-debugging/SKILL.md](./skills/systematic-debugging/SKILL.md) | blockers / test failures |
| Verification | [skills/verification-before-completion/SKILL.md](./skills/verification-before-completion/SKILL.md) | verify phase |
| Code review | [skills/requesting-code-review/SKILL.md](./skills/requesting-code-review/SKILL.md) | review phase |

## Step 0 — Triage (after invoke)

Forge starts only when the user invoked `/forge` / `/forge:*` (except `/forge:skip`)
or asked for **Forge by name** — any phrasing counts: "use Forge", "with Forge",
"do forge work", "run the forge workflow", "start a forge session". Do not
self-start on substantial-looking work.

Once invoked, triage per
[references/substantial-work.md](./references/substantial-work.md) **before**
brainstorm or plan — invocation does not skip this step.

- **Substantial (tracked-change-worthy)** → continue Forge (bootstrap session if needed)
- **Existing tracked change** (already proposed via OpenSpec or specs) → follow
  the `/forge:apply` flow: bootstrap/resume the session, `forge phase implement
  --plan-type <engine> --openspec "<change>"`, then subagent-driven implement,
  verify, and review. Do **not** re-brainstorm, and never implement inline
- **Too small for a tracked change** → execute directly, no session
- **`/forge:skip`** → mark session `phase: skipped` if one exists; execute directly

If an active session exists, continue it for follow-ups on that work. An
unrelated request without an invoke does not start a new session.

Bootstrap session when entering Forge:

```bash
forge new <kebab-slug>
# optional: forge new <slug> --signal "add stripe refund"
```

`forge new` resolves pace (default `auto`) onto the session and runs the
plan-engine doctor in warn-only mode (missing OpenSpec CLI does not block
session creation; specs-engine projects skip the CLI check).

**Cursor sandbox:** Cursor agent shells often block writes outside the
workspace (`CURSOR_SANDBOX=native`). Fleet registration needs
`~/.forgekit/fleet/`. Every `forge` command that creates or updates a session
(`new`, `phase`, `prefs --session-set`, `fleet sync`, …) MUST run with
unrestricted shell permissions (`required_permissions: ["all"]` on the Shell
tool). If registration was blocked, `.forge/sessions/<id>/fleet-pending.json`
remains until `forge reminder` or `forge fleet sync` can write home.

Resume: `forge status` — it resolves the session itself and says so when more
than one is open. Do **not** read `.forge/active.json` and pass the id along:
the pointer is a hint, and passing it as `--session` silences the very check
that would have told you it was the wrong one.

Update phase as you progress:

```bash
forge phase <phase> [--plan-type openspec|specs] [--openspec <change>]
```

Valid phases: `triage`, `brainstorm`, `plan`, `implement`, `verify`, `review`, `finish`, `done`, `skipped`.

## Phase flow

| Phase | Action |
| ----- | ------ |
| brainstorm | [phases/brainstorm.md](./phases/brainstorm.md) → **skills/brainstorming** |
| plan | [references/plan-routing.md](./references/plan-routing.md) → engine from `.forge/config.json`: **OpenSpec** ([plan-openspec.md](./phases/plan-openspec.md)) or **specs** ([plan-specs.md](./phases/plan-specs.md)) |
| implement | [phases/implement.md](./phases/implement.md) → **subagent-driven-development** + **TDD**. One implementer per **work unit** — a `tasks.md` group, ≤4 tasks, 1:1 for money/auth/contracts/migrations — not one per task |
| verify | `resolvedCeremony: combined` (small low-risk change) → [phases/close.md](./phases/close.md) — one closer pass replaces verify + review (OpenSpec leftover sweep still runs first when available). Otherwise [phases/verify.md](./phases/verify.md) → **verification-before-completion** |
| review | Covered by close.md when combined; otherwise [phases/review.md](./phases/review.md) → **requesting-code-review** |
| finish | [phases/finish.md](./phases/finish.md) |

<HARD-GATE>
Do NOT write implementation code during brainstorm or plan phases until the user approves the tracked change (OpenSpec or specs).
</HARD-GATE>

<HARD-GATE>
Subagent model selection — full rules: [references/model-selection.md](./references/model-selection.md).

Before **every** Task/Agent/subagent dispatch (including retries):

1. Run `forge resolve-model --tier <fast|standard|capable>`.
2. Honor the JSON **literally** — never invent, remember, or pick a slug from the host’s available-models list.
3. If `omitModel` is `true`: **omit** the host `model` parameter entirely (do not pass null/empty/“auto”/any slug). Passing a named model when omit is true often forces a **metered/API** model and **bills the user** — that is forbidden.
4. If `omitModel` is `false`: pass `model` **exactly** as returned.
5. Metered/API billing only on **explicit user request** (or an existing `forge models metered` overlay). On failure, escalate **tier** and re-resolve — never hand-pick a replacement slug.
</HARD-GATE>

## Session artefacts

Layout: [references/forge-layout.md](./references/forge-layout.md)

Testing: [references/test-strategy.md](./references/test-strategy.md) — tier 1 scoped TDD per task, tier 2 narrow evidence per task, tier 3 full workspace once at verify.

## Guardrails (every phase)

- No autonomous `git commit` / push unless the user explicitly asks. **Never push.** The one sanctioned commit is `forge checkpoint` at a task-group boundary, and only when the project set `.forge/config.json` → `git.checkpoint` (default `off`); it refuses on the default branch and excludes `.forge/` scratch
- **Session health** — `forge status` returns a `health` verdict (`healthy` / `stale` / `red` / `done`). On resume, read it before continuing: a red e2e run or an idle session mid-implement is the first thing to tell the user about
- **High-risk floor** — money/auth/contracts/migrations need an **independent final review** (a reviewer other than you reading the whole change). `forge score` caps the session at 69 without one. If the user declines dispatch, record it with `forge phase done --final-review-waived "<reason>"` — **not** `forge defer`, which is for deferred *wiring*: an open deferral costs the full 10 deferral points and makes `forge integrity-check` refuse the transition outright. Prose caveats do not survive session cleanup; the waiver is kept on the session and in `.forge/sessions.jsonl`
- **Findings** — anything you notice that deserves work but is out of scope goes to `forge finding add "<text>" --kind <bug|debt|tradeoff|idea|process> --severity <blocker|major|minor|note> [--change <slug>]`, not into a report the next session will not read. Guardrails: **fix beats file** (if the fix is smaller than the write-up, make the fix); `--kind` and `--severity` are deliberate choices, never defaults; resolving a root cause obliges re-checking its dependents; never narrow a heuristic without a corpus measured first
- Tests required for behavior changes
- Trace ecosystem consumers when contracts change
- Honor `openspec/config.yaml` prefixes when the project uses them (OpenSpec engine)
- **Runtime integrity** — [references/runtime-integrity.md](./references/runtime-integrity.md): **spine.json mandatory every change** (rows or `notApplicable` — not keyword-gated); no stubs / false success; capability specs beat narrow task wording; every claimed capability needs a named production caller; when spine has rows the product loop must be **executed** — `e2e.json` steps + green `forge e2e run` (or BLOCKED), prose does not satisfy the gate; deferred wiring only via `forge defer` — `forge phase done` mechanically refuses on `forge integrity-check` failures

## Agent surfaces

| Agent | Skill (after `forgekit install`) | Project wiring (`forge init`) |
| ----- | ----------------------------- | ----------------------------- |
| **Cursor** | `~/.agents/skills/forge/` (pick that harness) | commands, `forge.mdc`, SessionStart hook (`forge init --cursor`) |
| **Claude Code** | `~/.claude/skills/forge/` | commands, `forge.md`, SessionStart + prompt hooks |
| **Codex CLI** | `~/.agents/skills/forge/` (pick that harness) | thin rule |
| **Copilot / Gemini / OpenCode** | `~/.agents/skills/forge/` (pick that harness; one dest) | *(none — global skill only)* |

**Planning (all agents):** after brainstorm, proceed directly to the configured engine — no plan-mode prompt. See [references/plan-routing.md](./references/plan-routing.md). Hooks remind agents to run the propose flow when `planType` is unset.

**Distribute:** edit `skills/forge/` in forgekit, then `forgekit install --skills forge --force` on each machine. The bundled skills are a maintained fork (see [skills/NOTICE.md](./skills/NOTICE.md)) — do not re-vendor from Superpowers.

## Do not edit vendor OpenSpec skills

OpenSpec vendor skills upgrade in place. Forge behaviour lives in this tree and [docs/forge.md](./docs/forge.md). Re-apply vendor patches with `forge overlay` after OpenSpec upgrades.
