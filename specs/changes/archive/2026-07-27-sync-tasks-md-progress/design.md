# Design: Sync task progress from `tasks.md`

## Decision

1. **Count checkboxes** in the linked change’s `tasks.md` (`- [ ]` / `- [x]`).
2. When `total > 0`, those counts override session/fleet progress for display and heal `session.json` on read paths (fleet list, status, reminder).
3. **Idle / STALE** uses `max(session.updatedAt, tasks.md mtime)` so checkbox work counts as activity even before a heal write.
4. Sessions without a change dir or with zero checkboxes keep the existing session counters (throwaway/direct / empty plan).

## Why not only document “always run --tasks-complete”

Agents already follow OpenSpec’s “tick the box” loop; a second manual counter will keep drifting. Operator surfaces must read the plan file.

## Risks

- Unticking a box lowers `tasksComplete` (correct).
- Healing on `fleet list` writes `session.json` — only when counts differ, so idle churn is avoided.
