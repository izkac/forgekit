# Checkpoint Scoped Staging

## Why

`forge checkpoint` runs `git add -A` excluding only `.forge/`, so an unrelated
untracked change dir (e.g. `specs/changes/other-change/`) is swept into this
session's checkpoint commit (F72). That made operators skip checkpoints entirely.

## What Changes

Refuse to checkpoint when untracked paths sit under a *foreign* change directory
(`<plan.dir>/changes/<other>/`, not the session's `openspecChange`, not
`archive/`). List the paths and exit non-zero. Staging otherwise unchanged.

## Capabilities

- `session-lifecycle`: checkpoint refuses foreign change untracked (delta)

## Impact

CLI checkpoint only. Docs/comments updated to match behaviour.
