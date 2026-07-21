---
name: /forge
id: forge
category: Workflow
description: Forge — start or resume disciplined development (brainstorm → plan → build → review)
---

Run the **Forge** workflow for substantial work.

Read and follow the Forge skill (`~/.cursor/skills/forge/SKILL.md`) and `~/.cursor/skills/forge/docs/forge.md`.

1. Triage — substantial work? (skip only if user said `/forge:skip`)
2. Resume from `.forge/active.json` or `forge new <slug>`
3. Continue from current `phase` in `session.json`

Subcommands: `/forge:brainstorm`, `/forge:plan`, `/forge:apply`, `/forge:build`, `/forge:status`, `/forge:harness`, `/forge:analyze`, `/forge:skip`
