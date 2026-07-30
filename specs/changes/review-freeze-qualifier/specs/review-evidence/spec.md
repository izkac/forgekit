# Delta for Review Evidence

## ADDED Requirements

### Requirement: A frozen verdict is replaced only by a pass that learnt something

Where a verdict has already been frozen for a session, a later pass SHALL replace
it only when that pass learnt something about the final review. A pass that finds
no record of the deciding review unit, where an earlier pass found one, SHALL NOT
replace the frozen verdict — the record was pruned between the two, and its
absence is not a finding about the review.

A pass that finds no record where no earlier pass found one either SHALL replace
the verdict normally. Nothing was dispatched, nothing has changed, and the fresh
reading is as good as the frozen one.

Whether the deciding unit was on record SHALL be recorded on the verdict when it
is frozen, and SHALL NOT be inferred later from the evidence grade. "The record
was pruned" and "nothing was ever dispatched" are identical in a single reading;
only the comparison between two passes separates them.

A verdict frozen before this fact was recorded SHALL remain valid and SHALL keep
the behaviour it had. Its absence SHALL NOT be read as "no unit was on record".

#### Scenario: A reviewer that ran, whose record is pruned before the gate

- **GIVEN** a high-risk change whose review file's prose reads independent
- **AND** one unstopped final-review dispatch below the request floor, so the
  verdict freezes as `independent` on `inferred` evidence with the unit on record
- **WHEN** the dispatch record is pruned and the session is taken to `done`
- **THEN** the frozen verdict is kept
- **AND** the money/auth floor does not refuse the transition

#### Scenario: A review nobody ever dispatched

- **GIVEN** a high-risk change whose review file's prose reads independent
- **AND** no review dispatch on record in either pass, so the verdict freezes as
  `independent` on `inferred` evidence with no unit on record
- **WHEN** the host later reports that nothing was dispatched
- **THEN** the frozen verdict is replaced by the fresh reading
- **AND** the money/auth floor refuses the transition

#### Scenario: The record changed rather than vanished

- **GIVEN** a frozen verdict whose unit was on record
- **AND** a later pass that still finds the unit, now carrying the operator's stop
- **WHEN** the verdict is re-measured
- **THEN** the fresh reading replaces the frozen one

#### Scenario: A verdict frozen before the fact was recorded

- **GIVEN** a session whose frozen verdict carries no record of whether the unit
  was seen
- **WHEN** a later pass re-measures
- **THEN** the verdict is kept or replaced exactly as it would have been before
  this requirement existed
- **AND** the missing record is not read as "no unit was on record"

#### Scenario: A verdict carrying a non-boolean in that field

- **GIVEN** a session whose frozen verdict records something other than a boolean
  for whether the unit was seen
- **WHEN** the verdict is read
- **THEN** the whole verdict is rejected as not a measurement
- **AND** the caller falls back to a live census
