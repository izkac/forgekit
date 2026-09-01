# Brainstorm phase

Read and follow [../skills/brainstorming/SKILL.md](../skills/brainstorming/SKILL.md) in full.

**Pace:** Honor `brainstorm.depth` from [../references/pace.md](../references/pace.md) / `forge status` — `full` (frontier rounds until the frontier is empty), `short` (cap at ~2 rounds; remaining open branches fold into recommended-answer Assumptions), or `minimal` (at most one intent-confirming round; unasked branches become Assumptions).

## Terminal state

After user approves the design:

1. Save to `.forge/sessions/<id>/brainstorm/notes.md` and `decisions.md`
2. Run the plan-time exit check with the shape you now know (design D2):
   `forge exit-check --tasks N --capabilities N --spine-rows N [--high-risk]`.
   Exit 0 → **offer** to leave Forge for this work instead of scaffolding a
   change, and wait for the answer — the command decides whether to *offer*,
   you decide whether to leave. Accepted → `forge phase skipped --exit-reason
   "<reason from the command>"`, before any change directory exists. Declined
   → `forge phase plan --exit-declined "<reason>"`, then continue to step 3.
   Exit 1 → no offer; continue to step 3.
3. Read [../references/plan-routing.md](../references/plan-routing.md) and **proceed to OpenSpec propose** — do not ask for a plan mode
4. Follow [plan-openspec.md](./plan-openspec.md) — **not** implementation until OpenSpec artefacts are approved

```bash
forge phase brainstorm
# after the exit check (step 2), if no exit was offered or it was declined:
forge phase plan --plan-type openspec --openspec <name>
```

<HARD-GATE>
Do NOT invoke implement phase or write production code until OpenSpec plan phase completes and user approves.
</HARD-GATE>
