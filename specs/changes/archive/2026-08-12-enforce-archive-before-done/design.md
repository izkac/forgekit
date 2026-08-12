# Design — Enforce Archive Before Done

## Context

The check is one predicate: *does the live change dir still exist at done time?*
The design work is entirely in **where it runs**, because the obvious home is
the wrong one and a reader would otherwise reverse-engineer why.

## Decision 1 — the check lives in the done-gate, not in `runIntegrityChecks`

`runIntegrityChecks` in `packages/cli/src/integrity.mjs` looks like the natural
home: it is the mechanical integrity gate, and `forge phase done` already routes
through it (`set-phase.mjs:463`). It is the wrong home.

`runIntegrityChecks` has three callers, and only one of them is at done time:

| Caller | When it runs | Is the change archived yet? |
| ------ | ------------ | --------------------------- |
| `set-phase.mjs:463` | `forge phase done\|finish` | yes — archive is finish step 2 |
| `integrity-check.mjs:42` | `forge integrity-check`, any phase | no — and correctly so |
| `score.mjs:389` | `forge score`, any phase | no |

`phases/finish.md` tells the operator to run `forge integrity-check` *before*
archiving. A check placed in `runIntegrityChecks` would therefore fire on the
very run that the documented sequence asks for, during implement and verify,
demanding an archive that must not happen yet. Worse, `score.mjs:389` awards 20
points for `integrity.ok`, so every mid-flight session would score zero on the
integrity axis for not having done a step it was not yet supposed to do.

The check therefore goes in `set-phase.mjs`, in the same done-gate function that
already holds the combined-ceremony check (`set-phase.mjs:454-461`) — existing
precedent for a rule that is only meaningful at done. `runIntegrityChecks` is
left untouched.

**Alternative considered:** pass the target phase into `runIntegrityChecks` and
guard the check on `phase === 'done' || 'finish'`. Rejected — it widens a shared
signature that three callers depend on, to relocate a check that has exactly one
valid caller. The done-gate already exists for this.

## Decision 2 — reuse `resolveChangeDir(..., forWrite: true)`

Two live-change-dir resolvers already exist:

- `resolveChangeDir({ forWrite: true })` (`integrity.mjs:101`) — honors
  `session.planType`, resolves the specs root through `resolveProjectPlanEngine`,
  and documents why taking `.dir` unconditionally is wrong for specs sessions in
  projects with no `plan` block (`integrity.mjs:116-121`).
- `hasLiveChangeDir` (`cleanup-sessions.mjs:154`) — a closure, not exported, that
  takes `.dir` unconditionally.

The gate reuses the first. `forWrite: true` is precisely the "live path only, no
archive fallback" semantics needed, and it is already the documented contract for
that flag. No new resolver is written, and `cleanup-sessions.mjs` is left alone —
unifying the two is a separate change with its own blast radius.

## Decision 3 — waiver as a named flag, not `--allow-incomplete`

`--allow-incomplete` already swallows every done-gate problem, so it would work
with zero new code. It sets `session.incompleteReason`, which the scorecard and
`.forge/sessions.jsonl` readers take to mean the work did not finish. For an
unarchived-but-complete session that is a false statement in a durable record.

`--archive-waived "<reason>"` mirrors `--final-review-waived`, whose own comment
(`set-phase.mjs:483-491`) states the principle this change is an instance of: a
rule that matters has to be a gate, and its waiver has to be a field so it
survives cleanup and reaches the ledgers. Prose caveats do not survive.

`--allow-incomplete` still bypasses the check, as it bypasses every other
done-gate problem. That is deliberate and unchanged.

## Risks

- **A stricter gate on an existing flow.** Anyone mid-session when this ships
  meets a new refusal at done. Mitigated by a message that names the exact
  command, and by the waiver flag.
- **Partial-archive states.** If both a live dir and an archived copy exist, the
  live dir wins and the gate fires. Correct: something is unfiled either way, and
  the operator should look.
