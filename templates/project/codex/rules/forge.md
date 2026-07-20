# Forge (thin rule)

Full workflow: `~/.codex/skills/forge/docs/forge.md` · Skill: user-installed **Forge** (`~/.codex/skills/forge/SKILL.md` after `forge install`).

**Default:** triage before implementation. Substantial work → **Forge**
(brainstorm → plan → subagent TDD implement → review).

**Planning engine:** recorded in `.forge/config.json` (`plan.engine`). After brainstorm, create the change directly — OpenSpec → `/opsx:propose`, built-in specs → `forge change new <slug>`. Skip with `/forge:skip` or when work is trivial.

Scratch: `.forge/` · CLI: `forge new|status|prefs|models|phase|doctor`

Do not edit vendor planning-engine skills — Forge orchestrates them.
