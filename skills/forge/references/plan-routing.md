# Plan routing — engine from project config

Forge always produces a tracked change; the **engine** comes from
`.forge/config.json` → `plan.engine` (written by `forge init`):

| `plan.engine` | Plan phase | Change location |
| ------------- | ---------- | --------------- |
| `openspec` (or config missing + `openspec/config.yaml` present) | [../phases/plan-openspec.md](../phases/plan-openspec.md) | `openspec/changes/<name>/` |
| `specs` | [../phases/plan-specs.md](../phases/plan-specs.md) | `<plan.dir>/changes/<name>/` (default `specs/`; set `plan.dir: openspec` to reuse an OpenSpec tree) |


<HARD-GATE>
Do NOT ask the user to choose a plan mode or engine. The engine is project
config, not conversation. After brainstorm approval, proceed directly to the
configured engine's propose flow.
</HARD-GATE>

## Rule

**If work warrants Forge, it warrants a tracked change.** Work that is too
small for a tracked change should **not** enter Forge — execute directly or
use `/forge:skip`.

## After brainstorm approval

Follow the phase file for the configured engine — prefix (OpenSpec projects),
propose, set-phase, approval. Do **not** offer throwaway `.forge/.../plan.md`
or direct-from-brainstorm implementation paths.

## Engine not configured

If `.forge/config.json` has no `plan` block and there is no
`openspec/config.yaml`, tell the user to run `forge init` (which offers
OpenSpec setup or the built-in specs engine) — do not invent a layout.

## Triage alignment

Triage rules live in [substantial-work.md](./substantial-work.md). Before
bootstrapping a session, confirm the work would produce a tracked change under
the configured engine; when ambiguous, ask one clarifying question.

## Legacy plan types

`planType: throwaway` and `planType: direct` on **existing** sessions may
finish per [../phases/finish.md](../phases/finish.md). Do not start new
sessions with those modes.

## Scope growth mid-session

If implement scope grows beyond the approved change, stop and extend the
current change (or propose a follow-up change) — do not fall back to throwaway
or direct planning.
