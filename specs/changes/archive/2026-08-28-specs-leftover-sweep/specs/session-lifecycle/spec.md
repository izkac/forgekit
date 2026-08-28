# Delta for session-lifecycle

## ADDED Requirements

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

## MODIFIED Requirements

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

## REMOVED Requirements
