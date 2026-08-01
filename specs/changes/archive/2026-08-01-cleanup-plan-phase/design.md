# Design — cleanup-plan-phase

## Context

`holdsWork` walks the session directory for non-scaffold files. Plan-phase
work is written to `<plan.dir>/changes/<openspecChange>/` by the specs
engine. An aged unfinished plan session with only scaffold files inside
`.forge/sessions/<id>/` is deleted by retention even though the change
still exists.

## Decision

Extend the “has work” gate: unfinished + (`holdsWork(sessionDir)` OR
active change dir exists for `session.openspecChange`).

Active means `path.join(planRoot, 'changes', name)` exists as a directory
and is not under `changes/archive/`. Read plan root from `.forge/config.json`
(`plan.dir`, default `specs`) relative to project cwd.

## Alternatives rejected

- Only check brainstorm notes in the session dir (misses plan-only work).
- Never age-out unfinished sessions (too sticky; `--include-unfinished`
  already exists for intentional deletion).

## Risks

- Mis-set `openspecChange` to an unrelated live change would over-protect —
  rare operator error; still safer than silent delete.
