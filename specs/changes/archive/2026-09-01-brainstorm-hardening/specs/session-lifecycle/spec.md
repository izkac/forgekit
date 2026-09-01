# Delta for Session Lifecycle

## ADDED Requirements

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
