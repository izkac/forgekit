# Proposal: Sync task progress from `tasks.md`

## Problem

Forge sessions keep `tasksComplete` / `tasksTotal` in `session.json`, updated only when an agent runs `forge phase … --tasks-complete N`. OpenSpec / specs `tasks.md` checkboxes are the plan agents actually tick. Fleet, status, and health read the session cache — so a busy implement session can show `0/N` and `STALE` while dozens of boxes are checked.

## Change

Treat `tasks.md` checkboxes as the source of truth for progress when a session has a linked change (`openspec` / `specs`). Derive counts for fleet / status / health, heal `session.json` when they diverge, and treat `tasks.md` mtime as session activity for idle/STALE.

## Scope

- In: plan progress reader, fleet reconcile, `sessionHealth` idle clock + progress display, status/reminder heal path, docs/implement wording
- Out: changing OpenSpec vendor CLI; removing `--tasks-complete` (still used for `--subagents` bookkeeping)
