# 0002. Plan `tasks.md` checkboxes are progress source of truth

- **Status:** Accepted
- **Date:** 2026-07-27
- **Area:** session / fleet / health
- **Related:** `specs/changes/archive/2026-07-27-sync-tasks-md-progress/`

## Context

Forge mirrored implementation progress in `session.tasksComplete`, updated only
when an agent ran `forge phase … --tasks-complete N`. Agents (and OpenSpec’s
apply loop) mark done by ticking `tasks.md` checkboxes. Fleet and health read
the session cache, so a live implement session could show `0/N` and `STALE`
while the plan checklist was half done.

## Decision

For sessions linked to an openspec/specs change whose `tasks.md` has checkbox
lines:

1. Checkbox counts are authoritative for `tasksComplete` / `tasksTotal`.
2. Status, fleet list, and the reminder hook heal `session.json` when the cache
   diverges.
3. Idle/STALE uses `max(session.updatedAt, tasks.md mtime)` so checklist edits
   count as activity.

`--tasks-complete` remains for optional `--subagents` bookkeeping; it is not
required for operator progress display.

## Alternatives considered

- **Document-only:** require agents to always bump `--tasks-complete`. Rejected —
  they already follow the checkbox loop; a second counter keeps drifting.
- **Display-only overlay without healing session.json.** Rejected — status and
  ledger would still disagree with fleet until the next phase write.

## Consequences

- **Positive:** Fleet/status match the plan agents actually update; false STALE
  from forgotten counters goes away.
- **Negative:** Unticking a box lowers reported progress (correct, but visible).
- **Neutral:** Sessions with no change dir or no checkboxes still use the
  session counters.

## References

- Archive: `specs/changes/archive/2026-07-27-sync-tasks-md-progress/`
- Spec: `specs/specs/session-progress/spec.md`
- Code: `packages/cli/src/plan-progress.mjs`
