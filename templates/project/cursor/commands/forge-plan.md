---
name: /forge:plan
id: forge-plan
category: Workflow
description: Forge — plan phase (tracked change propose)
---

Plan phase. Follow ~/.cursor/skills/forge/references/plan-routing.md`.

**Engine from `.forge/config.json` → `plan.engine`** — do not ask for a plan mode:

- `openspec` → run `/opsx:propose <prefix>-<slug>` or the `openspec-propose` skill per [plan-openspec.md](~/.cursor/skills/forge/phases/plan-openspec.md)
- `specs` → author `specs/changes/<name>/{proposal,tasks}.md` per [plan-specs.md](~/.cursor/skills/forge/phases/plan-specs.md)

Get user approval on the change artefacts before `/forge:build` or `/forge:apply`.
