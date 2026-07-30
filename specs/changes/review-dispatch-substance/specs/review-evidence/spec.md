# Delta for Review Evidence

## ADDED Requirements

### Requirement: A dispatch must carry substance before it certifies a review

Where the host recorded a review dispatch for a unit, the record SHALL decide
that unit's verdict only when at least one dispatch the operator did not stop
did enough work to be a review. Below that floor the host SHALL report no
answer, and the verdict SHALL fall back to the review file's prose.

Substance SHALL be measured as the request count of a single dispatch, never as
the sum across dispatches: many token dispatches are not one review.

A dispatch stopped by the operator SHALL NOT contribute its substance to the
unit. Its own outcome is already decided by the operator's refusal.

Falling below the floor SHALL NOT by itself produce a verdict of `self`, and
SHALL NOT by itself refuse a transition. It routes the decision to the review
file's prose, which may then refuse on its own grounds.

These are requirements on the census's answer, in a single pass, and are not
end-to-end guarantees about `forge phase done`. They are stated that way because
they are not true end to end today: a verdict graded `inferred` is not protected
by the freeze, so a later pass that reads a manufactured host negative can
overwrite it and refuse. That is a defect in the freeze qualifier, recorded
separately, and not licence for this requirement to be read as covering it.

Where every dispatch for a unit was stopped, the operator's refusal SHALL decide
the unit and the floor SHALL NOT be consulted. Such a unit reports a busiest
dispatch of zero, which would otherwise fall below any floor and discard a
measurement the operator themselves produced.

#### Scenario: A token dispatch against a review file that admits no reviewer ran

- **GIVEN** a session whose only final-review dispatch made 1 request
- **AND** the review file's prose states no subagent read the change
- **WHEN** the census runs
- **THEN** the final review is `self`
- **AND** its evidence is `inferred`, not `host`

#### Scenario: A reviewer that genuinely ran

- **GIVEN** a session whose final-review dispatch made 55 requests
- **AND** the review file's prose reads like a self-check
- **WHEN** the census runs
- **THEN** the final review is `independent`
- **AND** its evidence is `host`

#### Scenario: Many token dispatches for one unit

- **GIVEN** a session with ten final-review dispatches, each of 1 request
- **WHEN** the census runs
- **THEN** the host reports no answer for that unit
- **AND** the verdict comes from the review file's prose

#### Scenario: A stopped dispatch beside a token one

- **GIVEN** a final-review dispatch of 60 requests that the operator stopped
- **AND** a second final-review dispatch of 1 request that ran to completion
- **WHEN** the census runs
- **THEN** the stopped dispatch's requests do not vouch for the second
- **AND** the host reports no answer for that unit

#### Scenario: A reviewer whose transcript was pruned

- **GIVEN** a final-review dispatch whose sidecar meta survives but whose
  transcript does not, so its request count reads 0
- **WHEN** the census runs
- **THEN** the host reports no answer for that unit
- **AND** the verdict comes from the review file's prose
- **AND** the census refuses nothing on account of the missing transcript

  (Scoped to this pass. If the sidecar directory is later emptied as well, the
  freeze qualifier can still refuse the transition — see the note above.)

### Requirement: Unit evidence reports the busiest single unstopped dispatch

Each unit's evidence SHALL carry the request count of its busiest dispatch among
those the operator did not stop, alongside the existing total across all
dispatches. A unit whose every dispatch was stopped SHALL report zero for the
busiest.

The floor itself SHALL NOT live with this measurement. Measurement and policy
are separate: the evidence collector reports counts, the census decides what
count is enough.

#### Scenario: Two dispatches, one stopped

- **GIVEN** a unit with a stopped dispatch of 60 requests and a completed
  dispatch of 20
- **WHEN** the evidence is read
- **THEN** the unit's total requests are 80
- **AND** the unit's busiest unstopped dispatch is 20

#### Scenario: Every dispatch stopped

- **GIVEN** a unit whose only two dispatches were both stopped
- **WHEN** the evidence is read
- **THEN** the unit's busiest unstopped dispatch is 0

#### Scenario: Evidence round-tripped through JSON without the new field

- **GIVEN** an evidence object built before this change, whose buckets carry no
  busiest-dispatch count
- **WHEN** the census reads it
- **THEN** the host reports no answer for that unit
- **AND** the verdict comes from the review file's prose
