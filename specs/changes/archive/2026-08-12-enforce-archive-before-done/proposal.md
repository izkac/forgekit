# Enforce Archive Before Done

## Why

`phases/finish.md` documents finish as an ordered sequence: confirm tasks
complete, **archive the change**, optional ADR follow-up, then `forge phase
done`. Only the first and last steps are enforced. Nothing checks that the
archive happened, so a session reaches `phase: done` with its change still live
under `<plan.dir>/changes/<name>/`.

This is not hypothetical. Two changes shipped and merged to `main` without ever
being archived — `add-hard-v2-evaluation-tranche` (merged 2026-08-10) and
`recalibrate-triage-and-review` (merged 2026-08-12, released 0.3.39). Both
recorded `phase: done` with tasks 12/12 and 31/31. Neither was caught.

The cost is not the unfiled directory. `forge change archive` merges delta specs
into `<plan.dir>/specs/<cap>/spec.md` as its first step, so skipping it leaves
the source of truth stale: 17 requirements across five capabilities described
behavior that had already shipped to users, and `specs/specs/pace-signals/spec.md`
had no record of the agent-decided triage that 0.3.39 was released on.

The gate is silent by construction. `resolveChangeDir` in
`packages/cli/src/integrity.mjs` falls back to the archived copy when the live
dir is gone (`liveOrArchived`, lines 94-99) so that spine and e2e still resolve
*after* archiving. That fallback is correct and must stay. Its side effect is
that the done-gate reads identically in both states and can never tell them
apart — the one place positioned to notice is structurally blind.

## What Changes

- `forge phase done` and `forge phase finish` refuse when the session names a
  change whose directory is still live under `<plan.dir>/changes/<name>/`.
- The refusal names the engine-correct remedy: `forge change archive <name>` for
  the specs engine, `openspec archive` for OpenSpec.
- New `--archive-waived "<reason>"` flag records a deliberate unarchived finish
  as `session.archiveWaived`, mirroring `--final-review-waived`.
- `archiveWaived` is carried into `.forge/sessions.jsonl` so the decision
  survives session cleanup.
- `phases/finish.md` states that the archive step is now enforced, not advisory.

## Capabilities

- `session-lifecycle`: the done-gate learns the archive step — delta at
  `specs/session-lifecycle/spec.md`

## Impact

Affected code: `packages/cli/src/set-phase.mjs` (new done-gate check, flag
parsing), `packages/cli/src/ledger.mjs` (one field), and the vendored
`phases/finish.md`. `packages/cli/src/integrity.mjs` is read but not modified —
its `liveOrArchived` fallback stays exactly as-is.

Behavior change for existing users: a session that would previously have reached
`done` unarchived now stops. This is the intent, and the message states the fix
in one command. The escape hatch is a named flag rather than the blunt
`--allow-incomplete`, so a scorecard cannot silently read "work incomplete" for
a session whose work was in fact complete.

Deliberately out of scope: the two already-shipped changes were archived by hand
before this change was written, so there is no backfill or migration step.
