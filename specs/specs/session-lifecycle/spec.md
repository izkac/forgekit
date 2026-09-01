# Session Lifecycle Spec

## Purpose

Describe this capability.

## Requirements

### Requirement: Cleanup treats a live plan change dir as held work
An unfinished Forge session whose `openspecChange` names an existing
directory under `<plan.dir>/changes/<name>/` (not under `changes/archive/`)
SHALL be treated as holding work for cleanup retention, even when the
session directory contains only Forge scaffold files.

#### Scenario: Aged plan session with live change dir is retained

- GIVEN an unfinished session older than retention
- AND `session.openspecChange` is `example-change`
- AND `<plan.dir>/changes/example-change/` exists
- AND the session directory holds only scaffold files
- WHEN `forge cleanup` runs without `--include-unfinished`
- THEN that session directory is not removed

#### Scenario: Explicit unfinished delete still works

- GIVEN the same session as above
- WHEN `forge cleanup --include-unfinished --session <id>` runs
- THEN that session directory is removed

#### Scenario: Archived change does not protect

- GIVEN `openspecChange` names a change that exists only under
  `changes/archive/…`
- AND the session directory holds only scaffold files
- WHEN bare `forge cleanup` ages the unfinished session out
- THEN retention may remove the session (change-dir gate does not apply)

### Requirement: Cleanup plan root follows the project plan engine
When resolving whether an `openspecChange` names a live change directory,
cleanup SHALL use the project plan engine root from
`resolveProjectPlanEngine` (with user-default disabled). An OpenSpec project
whose config has `plan.engine` of `openspec` and no `plan.dir` SHALL look
under `openspec/changes/<name>/`, not `specs/changes/<name>/`.

#### Scenario: OpenSpec engine without plan.dir retains plan session

- GIVEN `.forge/config.json` contains `{ "plan": { "engine": "openspec" } }`
- AND an unfinished aged session with `openspecChange` `example-change`
- AND `openspec/changes/example-change/` exists
- AND the session directory holds only scaffold files
- WHEN bare `forge cleanup` runs
- THEN that session directory is not removed

### Requirement: Checkpoint refuses foreign untracked change dirs
`forge checkpoint` SHALL refuse to stage when the working tree has untracked
paths under `<plan.dir>/changes/<other>/` where `<other>` is not the session's
`openspecChange` and is not `archive`. The refusal SHALL list those paths.
It SHALL NOT commit another change's in-progress untracked files under this
session's checkpoint subject.

#### Scenario: Sibling untracked change dir blocks checkpoint

- GIVEN an active session with openspecChange `my-change`
- AND an untracked file under `specs/changes/other-change/`
- WHEN forge checkpoint runs
- THEN it exits non-zero without creating a commit
- AND the message names the foreign path(s)

### Requirement: Shaped work is re-triaged before the plan is written
After brainstorm, and before change artefacts are produced, Forge SHALL
evaluate the shaped work against the plan-time exit conditions: few tasks, a
single capability, no wired spine rows, and no high-risk surface. When all hold,
Forge SHALL offer to leave rather than produce a proposal, design, tasks, spine
and brief for the change.

#### Scenario: Small shaped work offers an exit

- **GIVEN** brainstorm resolved the work to a two-task, single-capability change
  with no wired spine rows and no high-risk surface
- **WHEN** the plan phase begins
- **THEN** Forge offers to leave Forge for this work
- **AND** no change directory is scaffolded before that offer is answered

#### Scenario: Substantial shaped work proceeds without an offer

- **GIVEN** brainstorm resolved the work to a multi-capability change with wired
  spine rows
- **WHEN** the plan phase begins
- **THEN** no exit is offered and the change is scaffolded as today

#### Scenario: High-risk work never offers an exit

- **GIVEN** shaped work touching authentication, however small
- **WHEN** the plan phase begins
- **THEN** no exit is offered

### Requirement: Leaving Forge is recorded, never silent
When a session leaves Forge through the plan-time exit ramp, it SHALL be
recorded with the terminal phase for skipped work and SHALL carry the resolved
shape as its reason. A session SHALL NOT be abandoned without that record.

#### Scenario: An exited session is countable

- **GIVEN** a session that took the plan-time exit
- **WHEN** the session ledger is read
- **THEN** the session appears with the skipped phase
- **AND** its recorded reason names the task count, capability count and the
  absence of wired spine rows

#### Scenario: The offer is declined

- **GIVEN** a session offered the plan-time exit
- **WHEN** the user chooses to continue with a tracked change
- **THEN** the session proceeds to plan
- **AND** the declined offer is recorded on the session

### Requirement: A finished change is filed before the session is done
`forge phase done` and `forge phase finish` SHALL refuse the transition when the
session names a change whose directory still exists live under
`<plan.dir>/changes/<name>/`. The live path SHALL be resolved with no archive
fallback, so a change that has been archived satisfies the gate and one that has
not cannot. The refusal message SHALL name the remedy for the session's own plan
engine: `forge change archive <name>` for the specs engine, `openspec archive`
for OpenSpec.

The gate SHALL apply only at `done` and `finish`. `forge integrity-check` and
`forge score` SHALL NOT report an unarchived change as a problem at any phase,
because the documented finish sequence runs them before the archive step.

#### Scenario: A complete but unfiled change stops at done

- **GIVEN** a session with all tasks complete and `openspecChange` `example-change`
- **AND** `<plan.dir>/changes/example-change/` still exists
- **WHEN** `forge phase done` runs
- **THEN** it exits non-zero without recording phase `done`
- **AND** the message names `forge change archive example-change`

#### Scenario: An archived change passes

- **GIVEN** the same session
- **AND** the change exists only under `<plan.dir>/changes/archive/<date>-example-change/`
- **WHEN** `forge phase done` runs
- **THEN** the transition succeeds

#### Scenario: An OpenSpec session is told the OpenSpec command

- **GIVEN** a session whose `planType` is `openspec` with a live change dir
- **WHEN** `forge phase done` runs
- **THEN** the refusal names `openspec archive`
- **AND** it does not name `forge change archive`

#### Scenario: A session with no tracked change is unaffected

- **GIVEN** a session whose `openspecChange` is unset
- **WHEN** `forge phase done` runs
- **THEN** the archive gate raises no problem

#### Scenario: Mid-flight integrity runs stay quiet

- **GIVEN** a session at implement phase with a live change dir
- **WHEN** `forge integrity-check` runs
- **THEN** no problem is reported about the change being unarchived
- **AND** `forge score` does not deduct integrity points for it

### Requirement: An unarchived finish is waived by name and recorded
`forge phase done|finish` SHALL accept `--archive-waived "<reason>"`, which
allows the transition with the change still live and records the reason as
`session.archiveWaived`. The field SHALL be written into `.forge/sessions.jsonl`
so the decision outlives session cleanup. An empty or missing reason SHALL NOT
satisfy the flag.

Waiving the archive SHALL NOT set `session.incompleteReason`, which states that
the work did not finish and would be false for a complete change that was merely
left unfiled.

#### Scenario: A named waiver passes the gate

- **GIVEN** a complete session with a live change dir
- **WHEN** `forge phase done --archive-waived "held live for the follow-up tranche"` runs
- **THEN** the transition succeeds
- **AND** `session.archiveWaived` holds that reason
- **AND** `session.incompleteReason` is unset

#### Scenario: The waiver reaches the ledger

- **GIVEN** a session finished with `--archive-waived`
- **WHEN** its `.forge/sessions.jsonl` row is written
- **THEN** the row carries the `archiveWaived` reason

#### Scenario: A bare flag does not waive

- **GIVEN** a complete session with a live change dir
- **WHEN** `forge phase done --archive-waived` runs with no reason
- **THEN** the archive gate still refuses the transition

### Requirement: A Forge session starts only on explicit invocation
The agent SHALL start a Forge session only when the user invoked `/forge` or `/forge:*` (except `/forge:skip`) or asked for Forge by name in any phrasing (“use Forge”, “with Forge”, “do forge work”, “run the forge workflow”, “start a forge session”). A plain request, even one that would produce a tracked change, SHALL be executed directly without bootstrapping a session.

`isForgeInvocation` SHALL return true for those invoke forms and false for a plain implementation request, a read-only question about Forge, and the word `forgekit`.

When a Forge session is already active, follow-ups on that work MAY continue the session without a second invoke. An unrelated request without an invoke SHALL NOT start a new session.

#### Scenario: Slash command starts Forge

- **GIVEN** no active session
- **WHEN** the user sends `/forge add rate limiting`
- **THEN** the agent enters Forge (triage first, then `forge new` if the work is substantial)

#### Scenario: Natural language starts Forge

- **GIVEN** no active session
- **WHEN** the user sends `Use Forge. Add rate limiting.`
- **THEN** `isForgeInvocation` is true
- **AND** the agent enters Forge (triage first)

#### Scenario: Forge-by-name phrasing starts Forge

- **GIVEN** no active session
- **WHEN** the user sends `Do forge work over the add-auth openspec change`
- **THEN** `isForgeInvocation` is true
- **AND** the agent enters Forge

#### Scenario: Plain work does not start Forge

- **GIVEN** no active session
- **WHEN** the user sends `Add rate limiting to the public API.`
- **THEN** `isForgeInvocation` is false
- **AND** the agent does not bootstrap a Forge session

### Requirement: Triage is the first step after invoke
After an invoke, the agent SHALL still triage before brainstorm or plan: substantial work continues the Forge pipeline; trivial, read-only, or `/forge:skip` work executes directly. Invocation does not skip triage.

#### Scenario: Invoked typo may skip the pipeline

- **GIVEN** the user sent `/forge fix the typo in README`
- **WHEN** triage runs
- **THEN** the agent may execute directly without brainstorm/plan
- **AND** it does not skip the triage step itself

### Requirement: An invoked existing tracked change routes to the apply flow
When the user invokes Forge over a change that is already proposed (OpenSpec `openspec/changes/<name>/` or specs `specs/changes/<name>/`), the agent SHALL follow the `/forge:apply` flow: bootstrap or resume a session, set `forge phase implement` with the engine and change, and run subagent-driven implement, verify, and review. The agent SHALL NOT re-brainstorm or implement the change inline.

#### Scenario: Forge work over an existing OpenSpec change

- **GIVEN** `openspec/changes/add-auth/` exists and no active session
- **WHEN** the user sends `Do forge work over the add-auth change`
- **THEN** the agent bootstraps a session (`forge new`), sets `forge phase implement --plan-type openspec --openspec "add-auth"`
- **AND** implements via subagents with per-task review, then verify and final review

#### Scenario: /forge over an existing change routes the same way

- **GIVEN** `openspec/changes/add-auth/` exists and no active session
- **WHEN** the user sends `/forge implement the add-auth change`
- **THEN** the `/forge` command itself routes to the apply flow (session, implement phase, subagents)
- **AND** the agent does not implement the change inline in coordinator context

### Requirement: OpenSpec leftover sweep before final review
When a session's `planType` is `openspec` and the vendor `openspec-verify-change`
skill or `/opsx:verify` command exists in the project, Forge SHALL run that
sweep during verify, fix every reported finding (including files not listed in
`tasks.md`), and record `.forge/sessions/<id>/openspec-verify.md` with a
`Remaining: none` line **before** dispatching the final reviewer. `forge phase
review` and `forge phase done|finish` SHALL refuse while that file is missing
or lacks `Remaining: none`. Specs-engine sessions SHALL skip this OpenSpec
gate even when the vendor skill exists — they satisfy leftover sweep via
`spec-verify.md` instead. OpenSpec sessions whose project has no verify skill
SHALL skip this gate. `--allow-incomplete` waives it the same way as other
done-gate problems.

#### Scenario: OpenSpec verify skill present refuses review without the report

- **GIVEN** a session with `planType` `openspec`
- **AND** `.cursor/skills/openspec-verify-change/SKILL.md` exists
- **AND** the session has no `openspec-verify.md`
- **WHEN** `forge phase review` runs
- **THEN** the command exits non-zero
- **AND** the message names `openspec-verify.md`

#### Scenario: Vendor ready-for-archive is not enough

- **GIVEN** the same session
- **AND** `openspec-verify.md` says ready for archive with noted improvements
- **AND** it has no `Remaining: none` line
- **WHEN** `forge phase review` runs
- **THEN** the command exits non-zero

#### Scenario: Remaining none opens review, then final review

- **GIVEN** the same session
- **AND** `openspec-verify.md` contains a `Remaining: none` line
- **WHEN** `forge phase review` runs
- **THEN** the transition succeeds
- **AND** the coordinator dispatches the final reviewer on the post-fix diff

#### Scenario: Specs-engine skips the OpenSpec file

- **GIVEN** a session with `planType` `specs`
- **AND** the vendor verify skill exists in the project
- **WHEN** `forge phase done` runs (other done gates passing, including
  `spec-verify.md` with `Remaining: none`)
- **THEN** missing `openspec-verify.md` does not refuse the transition

### Requirement: Specs leftover sweep before final review
When a session's `planType` is `specs`, Forge SHALL run a leftover sweep
during verify — completeness, correctness, coherence, and leftover uses of
names the change is retiring, including files not listed in `tasks.md` — and
record `.forge/sessions/<id>/spec-verify.md` with a `Remaining: none` line
**before** dispatching the final reviewer (or the combined closer). The sweep
SHALL follow the bundled Forge skill `specs-verify-change`. It SHALL NOT
depend on a vendor OpenSpec skill or CLI.

`forge phase review` and `forge phase done|finish` SHALL refuse while that
file is missing or lacks `Remaining: none`. OpenSpec sessions SHALL NOT
require `spec-verify.md`. `--allow-incomplete` waives the gate the same way
as other done-gate problems. Combined close SHALL run this sweep before the
closer.

Skip a finding only when it explicitly says no action, or it matches a
recorded design decision that fixing would contradict. A "ready for archive
(with noted improvements)" line is not enough.

#### Scenario: Specs session refuses review without the report

- **GIVEN** a session with `planType` `specs`
- **AND** the session has no `spec-verify.md`
- **WHEN** `forge phase review` runs
- **THEN** the command exits non-zero
- **AND** the message names `spec-verify.md`

#### Scenario: Ready-for-archive is not enough on specs

- **GIVEN** the same session
- **AND** `spec-verify.md` says ready for archive with noted improvements
- **AND** it has no `Remaining: none` line
- **WHEN** `forge phase review` runs
- **THEN** the command exits non-zero

#### Scenario: Remaining none opens review, then final review

- **GIVEN** the same session
- **AND** `spec-verify.md` contains a `Remaining: none` line
- **WHEN** `forge phase review` runs
- **THEN** the transition succeeds
- **AND** the coordinator dispatches the final reviewer on the post-fix diff

#### Scenario: OpenSpec session does not need spec-verify.md

- **GIVEN** a session with `planType` `openspec`
- **WHEN** `forge phase done` runs (other done gates passing)
- **THEN** missing `spec-verify.md` does not refuse the transition

#### Scenario: Combined close still sweeps first

- **GIVEN** a specs session with `resolvedCeremony` `combined`
- **WHEN** the coordinator enters close
- **THEN** it runs the leftover sweep and writes `Remaining: none`
- **AND** only then dispatches the closer

### Requirement: Plan transition requires the brainstorm Assumptions ledger
When a session's phase history contains `brainstorm`, `forge phase plan` SHALL
refuse the transition unless `.forge/sessions/<id>/brainstorm/notes.md` exists
and contains a level-2 `Assumptions` heading, printing a message that names the
file, the missing piece, and the waiver, and persisting nothing. A session whose
history has no `brainstorm` entry SHALL pass the gate untouched. The
`--notes-waived "<reason>"` flag SHALL record `session.notesWaived` and allow
the transition; the value SHALL appear in the session's sessions.jsonl row.

#### Scenario: Missing notes refuse the transition

- GIVEN a session that entered brainstorm and has no `brainstorm/notes.md`
- WHEN `forge phase plan` runs
- THEN it exits non-zero, names the expected file and the `--notes-waived`
  escape, and the session's phase is unchanged

#### Scenario: Notes without the heading refuse

- GIVEN `brainstorm/notes.md` exists but has no `## Assumptions` heading
- WHEN `forge phase plan` runs
- THEN it exits non-zero naming the missing heading

#### Scenario: Ledger present passes

- GIVEN `brainstorm/notes.md` with an `## Assumptions` section
- WHEN `forge phase plan` runs
- THEN the transition succeeds with no gate output

#### Scenario: Non-brainstorm session exempt

- GIVEN a session created straight into plan (no brainstorm in history)
- WHEN `forge phase plan` runs
- THEN the gate does not fire

#### Scenario: Waiver recorded

- GIVEN a brainstormed session with no notes and
  `--notes-waived "user accepted"`
- WHEN `forge phase plan` runs
- THEN the transition succeeds and `session.notesWaived` is
  "user accepted", visible in the sessions.jsonl row
