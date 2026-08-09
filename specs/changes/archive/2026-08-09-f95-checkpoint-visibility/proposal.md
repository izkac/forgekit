# Change: surface inert checkpoints at session creation

## Why
Configured per-group/per-task checkpoints cannot commit on `main`/`master` unless explicitly allowed. Discovering that only at the first group boundary leaves long sessions unprotected.

## What Changes
- `forge new` emits a structured and stderr warning when checkpointing is enabled but the current branch is a protected default branch.
- The warning gives actionable branch/override remedies without creating or committing anything.
- Off mode, feature branches, and explicit default-branch allowance remain quiet.
