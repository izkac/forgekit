---
name: /forge:apply
description: Forge — apply a tracked change with subagent TDD, verify, and review
category: Workflow
tags: [workflow, forge, openspec]
---

**Forge-owned command.** Use this instead of bare `/opsx:apply` for disciplined implementation of a tracked change (OpenSpec or built-in specs engine — `.forge/config.json` → `plan.engine`).

Read the Forge skill (`~/.claude/skills/forge/SKILL.md`) and `~/.claude/skills/forge/docs/forge.md`.

**Input**: Optionally specify a change name (e.g., `/forge:apply add-auth`). If omitted, infer from context or active Forge session.

## 0. Forge session

1. Announce: "Using Forge apply."
2. Resume `.forge/active.json` or bootstrap: `forge new <slug>`
3. Set phase (use the project's engine as plan-type):
   ```bash
   forge phase implement --plan-type openspec|specs --openspec "<change>"
   ```

## 1–5. Load the change

**OpenSpec engine** — vendor CLI, follow `openspec-apply-change` (same as `/opsx:apply` steps 1–5):

1. **Select the change** — announce "Using change: \<name\>"
2. `openspec status --change "<name>" --json`
3. `openspec instructions apply --change "<name>" --json`
4. Read all `contextFiles` from CLI output
5. Show progress (N/M tasks, schema, remaining tasks)

Handle blocked / all_done states per vendor skill before implementing.

**Specs engine** — no CLI:

1. **Select the change** under `<plan.dir>/changes/<name>/` (default `specs/changes/`) — announce "Using change: \<name\>"
2. Read `proposal.md`, `design.md` (if present), `tasks.md`
3. Show progress (N/M checkboxes, remaining tasks)

## 6. Implement (Forge — REQUIRED)

Follow ~/.claude/skills/forge/phases/implement.md`:

- **Do not** implement all tasks inline in coordinator context
- Per pending task: brief → **implementer** subagent (TDD first) → **spec reviewer** → **quality reviewer** → mark `- [x]` in `tasks.md`
- Bundled skills: `skills/subagent-driven-development` + `skills/test-driven-development`

Pause on unclear tasks, design issues, errors, or user interrupt.

## 7. Verify (Forge — REQUIRED when all tasks done)

Follow ~/.claude/skills/forge/phases/verify.md`:

```bash
forge phase verify
```

Run affected workspace tests — **audit per-task `test-evidence.md`**; do not re-run the same commands if subagents already recorded passing runs (see verify phase).

## 8. Review (Forge — REQUIRED)

Follow ~/.claude/skills/forge/phases/review.md`:

```bash
forge phase review
```

Final reviewer; save to `.forge/sessions/<id>/reviews/final-review.md`.

## 9. Finish

When verify + review pass: suggest archive — `/opsx:archive` (OpenSpec) or `forge change archive <name>` (specs; merges deltas into `<plan.dir>/specs/`) — per [finish phase](~/.claude/skills/forge/phases/finish.md).

**Skip Forge for this task only:** `/forge:skip` (runs work without brainstorm/plan/verify chain).
