# Brainstorm phase

Read and follow [../skills/brainstorming/SKILL.md](../skills/brainstorming/SKILL.md) in full.

**Pace:** Honor `brainstorm.depth` from [../references/pace.md](../references/pace.md) / `forge status` — `full` (default skill), `short` (≤2–3 approaches), or `minimal` (confirm intent + one approach when design is obvious).

## Terminal state

After user approves the design:

1. Save to `.forge/sessions/<id>/brainstorm/notes.md` and `decisions.md`
2. Read [../references/plan-routing.md](../references/plan-routing.md) and **proceed to OpenSpec propose** — do not ask for a plan mode
3. Follow [plan-openspec.md](./plan-openspec.md) — **not** implementation until OpenSpec artefacts are approved

```bash
forge phase brainstorm
# after OpenSpec propose:
forge phase plan --plan-type openspec --openspec <name>
```

<HARD-GATE>
Do NOT invoke implement phase or write production code until OpenSpec plan phase completes and user approves.
</HARD-GATE>
