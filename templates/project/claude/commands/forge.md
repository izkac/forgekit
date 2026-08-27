---
name: /forge
description: Forge — start or resume disciplined development (brainstorm → plan → build → review)
category: Workflow
tags: [workflow, forge, planning]
---

Run the **Forge** workflow for substantial work.

Read and follow the Forge skill (`~/.claude/skills/forge/SKILL.md`) and `~/.claude/skills/forge/docs/forge.md`.

1. Triage — always the first step after invoke. The agent decides whether this
   is substantial work. A trivial edit or read-only question skips the rest of
   the pipeline without `/forge:skip`; `/forge:skip` is one way to skip, not
   the only one. Natural language “use Forge” is the same invoke as `/forge`.
2. Resume with `forge status` (it resolves the session itself) or `forge new <slug>`
3. Continue from current `phase` in `session.json`

Subcommands: `/forge:brainstorm`, `/forge:plan`, `/forge:apply`, `/forge:build`, `/forge:status`, `/forge:harness`, `/forge:analyze`, `/forge:skip`
