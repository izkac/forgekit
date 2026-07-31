# Delta for Review Evidence

## ADDED Requirements

### Requirement: A review dispatch is stamped when its label is issued

`forge review-label` SHALL, after resolving the session and unit, write a
dispatch stamp into the session's own directory
(`reviews/dispatches.json`) recording the unit, the exact label, the
session id, the time, and the model resolved in-process at the reviewer's
tier. The stamp SHALL be appended, never overwritten. Failure to write the
stamp SHALL NOT block the label: the label is still printed, the failure
is reported on stderr, and stdout SHALL remain exactly the label.

#### Scenario: Labelling the final reviewer writes the stamp

- **GIVEN** an open session and a writable session directory
- **WHEN** `forge review-label final` runs
- **THEN** stdout is exactly `forge-review final <session-id>`
- **AND** `reviews/dispatches.json` gains a stamp with unit `final`, that
  label, that session id, a timestamp, and the model resolved at tier
  `capable`

#### Scenario: A stamp that cannot be written does not block the dispatch

- **GIVEN** a session whose `reviews/` directory cannot be created
- **WHEN** `forge review-label final` runs
- **THEN** the label is still printed on stdout and the exit code is 0
- **AND** the failure is reported on stderr

### Requirement: The stamp decides when the host cannot answer

Where host evidence cannot answer for the final unit — unavailable, or
carrying no well-formed record of that unit — a structurally valid stamp
for the final unit naming this session SHALL decide the verdict
`independent` with evidence `recorded`, and the review file's prose SHALL
NOT be consulted for it. Where host evidence can answer, it SHALL answer,
and the stamp SHALL NOT override it. A stamp SHALL NOT conjure a review: a
session with no final review file remains `none` regardless of stamps.

#### Scenario: A pruned transcript no longer erases the reviewer

- **GIVEN** a session whose final reviewer was labelled and stamped at
  dispatch time
- **AND** the host transcript has since been pruned from disk
- **AND** the review file's prose contains the words `self-check`
- **WHEN** the census runs
- **THEN** the final review is `independent`
- **AND** its evidence is `recorded`

#### Scenario: The host's answer outranks the stamp

- **GIVEN** a stamped final unit whose every host-recorded dispatch was
  stopped by the operator
- **WHEN** the census runs
- **THEN** the final review is `self` with evidence `host`
- **AND** `stoppedByOperator` is true

#### Scenario: A stamp naming a different session credits nothing

- **GIVEN** a `dispatches.json` whose only stamp names another session's id
- **AND** no host evidence
- **WHEN** the census runs
- **THEN** the verdict falls back to the review file's prose, graded
  `inferred`

#### Scenario: A malformed stamp file is an absence, not an error

- **GIVEN** a `reviews/dispatches.json` that is not valid JSON
- **WHEN** the census runs
- **THEN** the census does not throw
- **AND** the verdict falls back to the review file's prose, graded
  `inferred`

### Requirement: The stamp substitutes for lost records, never for missing work

Where host evidence carries a well-formed record of the final unit whose
busiest unstopped dispatch is below the substance floor, the verdict SHALL
fall back to the review file's prose and the stamp SHALL NOT be consulted.

#### Scenario: A stamped token dispatch does not certify a review

- **GIVEN** a stamped final unit whose host record shows one unstopped
  dispatch of 1 request
- **WHEN** the census runs
- **THEN** the verdict is read from the review file's prose, graded
  `inferred`
- **AND** the stamp contributes nothing
