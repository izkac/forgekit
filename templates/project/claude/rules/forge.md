# Forge (thin rule)

Full workflow: `~/.claude/skills/forge/docs/forge.md` · Skill: user-installed **Forge** (`~/.claude/skills/forge/SKILL.md` after `forge install`).

**Default:** triage before implementation. Substantial work → **Forge**
(brainstorm → OpenSpec → subagent TDD implement → review).

**Forge = OpenSpec:** after brainstorm, proceed directly to `/opsx:propose` — do not ask for a plan mode. Work too small for OpenSpec should skip Forge (`/forge:skip` or direct execution).

**Skip Forge** only when work is trivial OR user sends **`/forge:skip`**.

Scratch sessions: `.forge/sessions/` (14-day retention). Active pointer: `.forge/active.json`.

CLI: `forge new`, `forge status`, `forge prefs`, `forge models`, `forge phase`, `forge doctor`.

Do not edit vendor OpenSpec skills — Forge orchestrates them. Workflow skills are bundled under the Forge skill’s `skills/` folder.
