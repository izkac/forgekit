# Design — escape rate by pace, outside-plan flag

## D1. Escape rate by pace

`escapeReport` already builds the done set per session id (digest rows of every fleet project, then
registry done entries). Keep each session's pace with its done time: the digest row's `pace`, else the
registry entry's; null → `unknown`. Each done session bumps its month bucket, its pace bucket and the
total. `byPace` order: `CONCRETE_PACES` (thorough, standard, brisk, lite), then any other recorded value
alphabetically, `unknown` last; only paces with at least one done session appear. Text output adds a
`PACE  DONE  ESCAPED  RATE  OPEN` table under the month table.

## D2. Outside-plan flag

In `escapeCandidates`, once per session: plan files = `git diff --name-only --diff-filter=d base head --
<planDir>/` (the change's own proposal/design/tasks/specs, wherever the archive moved them), read at
`head` with one `git show head:<p> ...` call into one string. For each candidate,
`outsidePlan = files.filter(f => !planText.includes(basename(f)))`. No plan files in the range → `[]`.

Ceiling: basename substring match — a common basename (`index.ts`) reads as named, so the flag can miss
a sweep; it never hides a candidate.

## Decision: detection side, not checkpoint

- Alternatives considered: scope `forge checkpoint` to files the plan names (others left uncommitted
  unless `--path`); a per-session edit log from the PreToolUse hooks; a dirty-tree snapshot at session start.
- Rationale: Forge has no authorship record. The plan-name guess at checkpoint time would have left
  1 in 11 legitimate files uncommitted on main's history (`docs/usage.md`) and adds a step to every
  checkpoint; a hook log misses Bash edits and non-Claude hosts; the start snapshot misses F16's own case
  (CONTEXT.md was created mid-session). A swept line can only become a candidate, and confirming needs a
  replay test, so the rate stays honest — the flag makes the dismiss cheap.

## Risks / Trade-offs

- Measured on main: the flag marks both swept files of F16 and 1 of 11 legitimate hit files. A label
  with that error rate is useful; as a filter it would lose real Escapes, so it stays a label.
