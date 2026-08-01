# Delta for Review Evidence

## ADDED Requirements

### Requirement: Prescribed review coverage that never happened caps the grade

When a session's effective `review.perTask` setting prescribed per-group
reviewers and none were dispatched,
`forge score` SHALL cap the session's score. The cap SHALL be decided from the
review census directly — never from a variable that any code path leaves
unassigned — so that a session with no review artifacts at all is measured by
the same expression as a session with many.

An independent **final** review SHALL soften the cap but SHALL NOT remove it: it
answers whether an outside reader saw the finished whole, not whether the work
was reviewed as it was built.

#### Scenario: A session with no reviews of any kind is capped

- **GIVEN** a session at `thorough` or `standard` pace with at least 5 planned tasks
- **AND** its review census reports zero independent per-group reviews
- **AND** it has no independent final review
- **WHEN** `forge score` grades it
- **THEN** the score is capped at 69
- **AND** the cap is recorded in `caps` naming the missing review coverage

#### Scenario: An independent final review softens the cap to a B

- **GIVEN** a session at `thorough` or `standard` pace with at least 5 planned tasks
- **AND** its review census reports zero independent per-group reviews
- **AND** its final review is independent
- **WHEN** `forge score` grades it
- **THEN** the score is capped at 89
- **AND** the cap text distinguishes this from the no-reviewer-at-all case

#### Scenario: One dispatched reviewer lifts the cap

- **GIVEN** a session otherwise identical to the capped scenarios
- **AND** its review census reports at least one independent per-group review
- **WHEN** `forge score` grades it
- **THEN** no review-coverage cap is applied

#### Scenario: More review never scores worse than less

- **GIVEN** two sessions identical except that one has zero review artifacts and
  the other has one independent per-group review
- **WHEN** `forge score` grades both
- **THEN** the zero-review session's score is less than or equal to the other's

#### Scenario: A pace told to skip reviewers is not punished for obeying

- **GIVEN** a session at `brisk` or `lite` pace with zero independent per-group reviews
- **WHEN** `forge score` grades it
- **THEN** no review-coverage cap is applied

#### Scenario: A change too small to warrant a reviewer is not capped

- **GIVEN** a session at `standard` pace with fewer than 5 planned tasks
- **AND** zero independent per-group reviews
- **WHEN** `forge score` grades it
- **THEN** no review-coverage cap is applied

#### Scenario: The cap follows the frozen verdict, as the done gate does

- **GIVEN** a session whose frozen final-review verdict is `independent`
- **AND** whose review file prose alone would read as self-authored
- **WHEN** `forge score` grades it with zero independent per-group reviews
- **THEN** the cap applied is the 89 tier, matching the verdict the gate read

#### Scenario: A cap is noted only when it lowers the score

- **GIVEN** a session already scoring at or below the cap it qualifies for
- **WHEN** `forge score` grades it
- **THEN** the score is unchanged
- **AND** no applied-cap entry claims to have reduced it
