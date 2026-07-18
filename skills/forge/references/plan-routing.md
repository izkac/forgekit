# Plan routing — OpenSpec only

Forge **always** uses OpenSpec. There is no throwaway or direct plan mode for new work.

<HARD-GATE>
Do NOT ask the user to choose a plan mode. After brainstorm approval, proceed directly to OpenSpec propose.
</HARD-GATE>

## Rule

**If work warrants Forge, it warrants an OpenSpec change.** Work that is too small for a tracked
OpenSpec change should **not** enter Forge — execute directly or use `/forge:skip`.

## After brainstorm approval

Follow [../phases/plan-openspec.md](../phases/plan-openspec.md) — prefix, propose, set-phase, approval. Do **not** offer throwaway `.forge/.../plan.md` or direct-from-brainstorm implementation paths.

## Triage alignment

Triage rules live in [substantial-work.md](./substantial-work.md). Before bootstrapping a session, confirm the work would produce a tracked change under `openspec/changes/`; when ambiguous, ask one clarifying question.

## Legacy plan types

`planType: throwaway` and `planType: direct` on **existing** sessions may finish per
[../phases/finish.md](../phases/finish.md). Do not start new sessions with those modes.

## Scope growth mid-session

If implement scope grows beyond the approved OpenSpec change, stop and extend the current change
(or propose a follow-up change) — do not fall back to throwaway or direct planning.
