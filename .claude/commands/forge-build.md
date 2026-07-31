---
name: /forge:build
description: Forge — implement phase (subagent-driven + TDD)
category: Workflow
tags: [workflow, forge, openspec]
---

Implement phase. Follow ~/.claude/skills/forge/phases/implement.md`.

**REQUIRED:** forge `skills/subagent-driven-development` + `skills/test-driven-development` per task.

- OpenSpec plan → **`/forge:apply`** (preferred) or `openspec-apply-change` / `/opsx:apply` wrapped in subagent loop
- Specs plan (`planType: specs`) → **`/forge:apply`** — tasks from `<plan.dir>/changes/<name>/tasks.md`, no vendor CLI steps
- Throwaway plan → tasks from `.forge/.../plan.md`
- Direct → brief from `.forge/.../brainstorm/notes.md` + `decisions.md`

Then verify and review phases.
