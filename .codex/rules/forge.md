# Forge (thin rule)

Full workflow: `~/.codex/skills/forge/docs/forge.md` · Skill: user-installed **Forge** (`~/.codex/skills/forge/SKILL.md` after `forge install`).

**Default:** execute the request directly. Start Forge only when the user invokes `/forge` or asks to **use Forge**. Codex has no slash commands — the phrase is the invoke.

When Forge is invoked, **triage is always Step 0**. Skip with `/forge:skip` or when work is trivial.

If an active session exists, continue it for follow-ups on that work.

**Planning engine:** recorded in `.forge/config.json` (`plan.engine`). After brainstorm, create the change directly — OpenSpec → `/opsx:propose`, built-in specs → `forge change new <slug>`.

Scratch: `.forge/` · CLI: `forge new|status|prefs|models|resolve-model|phase|doctor`

**Subagent models:** always `forge resolve-model --tier …` then follow JSON (`omitModel: true` → omit host `model`; never pick from the host model list). See skill `references/model-selection.md`.

Do not edit vendor planning-engine skills — Forge orchestrates them.
