# Spec: review evidence

## Purpose

Forge must be able to say who reviewed a change on evidence the reviewed party
cannot author, and must say plainly when it cannot tell.

## Requirements

### Requirement: Authorship is measured from host evidence when it exists

Where the host recorded a subagent dispatch matching this session's review unit,
that record SHALL decide the verdict, and the review file's prose SHALL NOT be
consulted for it.

A dispatch record SHALL be matched to a Forge session by the session id carried
in its description, and by nothing else. A record naming a different session
SHALL NOT contribute to this session's verdict, and a record naming no session
SHALL contribute to no session's verdict.

#### Scenario: A dispatched reviewer whose report reads like a self-check

- **GIVEN** a session whose host sidecars include a reviewer dispatch for the final review
- **AND** the review file's prose contains the words `self-check`
- **WHEN** the census runs
- **THEN** the final review is `independent`
- **AND** its evidence is `host`

#### Scenario: A reviewer dispatched by a different session in the same conversation

- **GIVEN** two Forge sessions bound to one host session
- **AND** the only reviewer dispatch names the *other* session
- **AND** this session's review file declares it a self-check
- **WHEN** the census runs
- **THEN** the final review is `self`
- **AND** the neighbour's dispatch contributes nothing to this session's units

#### Scenario: A reviewer dispatch that names no session

- **GIVEN** a reviewer dispatch described in the older `forge-review <unit>` form
- **WHEN** the evidence is read
- **THEN** it is reported as unavailable
- **AND** the census falls back to the review file's prose

#### Scenario: A self-written review claiming to be dispatched

- **GIVEN** a session whose host sidecars include no reviewer dispatch for the final review
- **AND** the review file is headed `Reviewer: claude-opus-5 (final-reviewer)`
- **WHEN** the census runs
- **THEN** the final review is `self`
- **AND** its evidence is `host`

### Requirement: Absence of evidence never refuses work

Where host evidence is unavailable, the verdict SHALL fall back to the existing
prose reading, and SHALL NOT be reported as a self-check on the grounds of
absence alone.

#### Scenario: A host that writes no sidecars

- **GIVEN** a session bound to no host session, or whose transcript has been pruned
- **WHEN** the census runs
- **THEN** the verdict matches what the prose rule alone would return
- **AND** its evidence is `inferred`
- **AND** `forge phase done` behaves exactly as it did before this change

### Requirement: Adoption is detected, not assumed

Where the host recorded subagent dispatches for this session but **none** of them
carry the prescribed review label, the convention SHALL be treated as not in use
and the verdict SHALL fall back to the prose reading. A session SHALL NOT be
judged self-reviewed merely because its reviewer was dispatched with an
unprescribed description.

#### Scenario: A repo that has not adopted the convention

- **GIVEN** a session whose host sidecars contain dispatches, none of them prescribed
- **AND** a final review written by a genuinely dispatched reviewer
- **WHEN** the census runs
- **THEN** the verdict matches what the prose rule alone would return
- **AND** its evidence is `inferred`

#### Scenario: A repo that has adopted it

- **GIVEN** a session whose host sidecars contain at least one prescribed dispatch
- **AND** none of them is for the final review
- **WHEN** the census runs
- **THEN** the final review is `self`
- **AND** its evidence is `host`

#### Scenario: A session that dispatched nothing at all

- **GIVEN** a session whose host sidecars contain no dispatches at all
- **WHEN** the census runs
- **THEN** the final review is `self`
- **AND** its evidence is `host`

### Requirement: The verdict outlives its evidence

The verdict and its evidence grade SHALL be written into the session and the
durable digest when collected, and SHALL NOT be recomputed from evidence that
may since have been pruned.

#### Scenario: Transcript pruned after the session finished

- **GIVEN** a finished session whose verdict was `independent` with evidence `host`
- **WHEN** its host transcript is deleted and the digest is re-read
- **THEN** the recorded verdict and evidence are unchanged

### Requirement: A declined dispatch is reported, not assumed

Where the host records that an operator stopped a reviewer dispatch, the census
SHALL surface that fact and SHALL NOT treat it as either a completed review or
an automatic waiver.

#### Scenario: Operator declines the final reviewer

- **GIVEN** a sidecar for the final review carrying `stoppedByUser: true`
- **WHEN** the census runs
- **THEN** the final review is `self`
- **AND** the result records that a dispatch was stopped by the operator
- **AND** no waiver is applied on the session's behalf

### Requirement: Evidence records counts, never content

Persisted review evidence SHALL contain identifiers, counts and timestamps only.
The dispatch `description` SHALL NOT be written, even though its format is
prescribed.

#### Scenario: Reviewer dispatched with a descriptive label

- **GIVEN** a reviewer sidecar whose `description` carries free-form text beyond the prescribed token
- **WHEN** evidence is collected and persisted
- **THEN** no part of the description text appears in any written artifact
