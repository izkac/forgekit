---
name: forge
description: >-
  Forge — self-contained disciplined development workflow. Triage substantial work,
  brainstorm, tracked plan (OpenSpec or built-in specs engine), subagent-driven TDD
  implementation, verify, review, and finish.
  Use when building features, fixing non-trivial bugs, or when the user invokes /forge.
  Skip only when user says /forge:skip or work is trivial.
disable-model-invocation: false
---

# Forge

Spec-tracked development pipeline. Planning engine is per-project
(`.forge/config.json` → `plan.engine`): **OpenSpec** (vendor CLI) or the
**built-in specs engine** (`specs/changes/`, same layout). **Self-contained** —
all workflow skills live under `./skills/` (vendored from Superpowers MIT; see
[skills/NOTICE.md](./skills/NOTICE.md)).

Full reference: forgekit `docs/forge.md` (shipped with this skill’s source repo).

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
Local overlays: forgekit `docs/forge.md` § Checkout-local overrides.

## Bundled skills

| Skill | Path | When |
| ----- | ---- | ---- |
| Brainstorming | [skills/brainstorming/SKILL.md](./skills/brainstorming/SKILL.md) | brainstorm phase |
| TDD | [skills/test-driven-development/SKILL.md](./skills/test-driven-development/SKILL.md) | every implement task |
| Subagent-driven dev | [skills/subagent-driven-development/SKILL.md](./skills/subagent-driven-development/SKILL.md) | implement phase |
| Systematic debugging | [skills/systematic-debugging/SKILL.md](./skills/systematic-debugging/SKILL.md) | blockers / test failures |
| Verification | [skills/verification-before-completion/SKILL.md](./skills/verification-before-completion/SKILL.md) | verify phase |
| Code review | [skills/requesting-code-review/SKILL.md](./skills/requesting-code-review/SKILL.md) | review phase |

## Step 0 — Triage (default)

Before coding on any non-trivial request, run triage per
[references/substantial-work.md](./references/substantial-work.md).

- **Substantial (tracked-change-worthy)** → continue Forge (bootstrap session if needed)
- **Too small for a tracked change** → execute directly, no session
- **`/forge:skip`** → mark session `phase: skipped` if one exists; execute directly

Bootstrap session when entering Forge:

```bash
forge new <kebab-slug>
# optional: forge new <slug> --signal "add stripe refund"
```

`forge new` resolves pace (default `auto`) onto the session and runs the
plan-engine doctor in warn-only mode (missing OpenSpec CLI does not block
session creation; specs-engine projects skip the CLI check).

Resume: read `.forge/active.json` → `forge status`.

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
| implement | [phases/implement.md](./phases/implement.md) → **subagent-driven-development** + **TDD** |
| verify | [phases/verify.md](./phases/verify.md) → **verification-before-completion** |
| review | [phases/review.md](./phases/review.md) → **requesting-code-review** |
| finish | [phases/finish.md](./phases/finish.md) |

<HARD-GATE>
Do NOT write implementation code during brainstorm or plan phases until the user approves the tracked change (OpenSpec or specs).
</HARD-GATE>

<HARD-GATE>
Subagent dispatch: NEVER pass a model slug you picked yourself (including any from the host's model list). Run `forge resolve-model --tier <fast|standard|capable>` and honor its JSON — omit the `model` parameter when `omitModel` is true, else pass `model` exactly. Metered/API models only on explicit user request. This applies to retries and fallbacks too: if a dispatch fails, re-resolve — do not hand-pick a replacement slug.
</HARD-GATE>

## Session artefacts

Layout: [references/forge-layout.md](./references/forge-layout.md)

Testing: [references/test-strategy.md](./references/test-strategy.md) — tier 1 scoped TDD per task, tier 2 narrow evidence per task, tier 3 full workspace once at verify.

## Guardrails (every phase)

- No autonomous `git commit` / push unless the user explicitly asks
- Tests required for behavior changes
- Trace ecosystem consumers when contracts change
- Honor `openspec/config.yaml` prefixes when the project uses them (OpenSpec engine)

## Agent surfaces

| Agent | Skill (after `forgekit install`) | Project wiring (`forge init`) |
| ----- | ----------------------------- | ----------------------------- |
| **Cursor** | `~/.cursor/skills/forge/` | commands, `forge.mdc`, SessionStart hook |
| **Claude Code** | `~/.claude/skills/forge/` | commands, `forge.md`, SessionStart + prompt hooks |
| **Codex CLI** | `~/.codex/skills/forge/` | thin rule |

**Planning (all agents):** after brainstorm, proceed directly to the configured engine — no plan-mode prompt. See [references/plan-routing.md](./references/plan-routing.md). Hooks remind agents to run the propose flow when `planType` is unset.

**Distribute:** edit `skills/forge/` in forgekit, then `forgekit install --skills forge --force` on each machine. The bundled skills are a maintained fork (see [skills/NOTICE.md](./skills/NOTICE.md)) — do not re-vendor from Superpowers.

## Do not edit vendor OpenSpec skills

OpenSpec vendor skills upgrade in place. Forge behaviour lives in this tree and forgekit `docs/forge.md`. Re-apply vendor patches with `forge overlay` after OpenSpec upgrades.
