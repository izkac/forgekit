# Forge (thin rule)

Full workflow: `~/.claude/skills/forge/docs/forge.md` · Skill: user-installed **Forge** (`~/.claude/skills/forge/SKILL.md` after `forge install`).

**Default:** execute the request directly. Start Forge only when the user invokes `/forge` / `/forge:*` (except `/forge:skip`) or asks to **use Forge**.

When Forge is invoked, **triage is always Step 0** (substantial → pipeline; trivial/read-only → execute directly).

If an active session exists, continue it for follow-ups on that work. An unrelated request without an invoke does not start a new session.

**Planning engine:** this project's engine is recorded in `.forge/config.json` (`plan.engine`). After brainstorm, create the change spec directly — do not ask for a plan mode:
- OpenSpec → `/opsx:propose`
- built-in specs → `forge change new <slug>`

Work too small for a tracked change skips the rest of the pipeline after triage (`/forge:skip` or direct execution).

Scratch sessions: `.forge/sessions/` (14-day retention). Active pointer: `.forge/active.json`.

CLI: `forge new`, `forge status`, `forge prefs`, `forge models`, `forge resolve-model`, `forge phase`, `forge doctor`.

**Subagent models:** always run `forge resolve-model --tier …` first and follow its JSON. If `omitModel` is true, omit the host `model` parameter — never pick a slug from the host’s model list (that can bill the user). See skill `references/model-selection.md`.

Do not edit vendor planning-engine skills — Forge orchestrates them. Workflow skills are bundled under the Forge skill's `skills/` folder.
