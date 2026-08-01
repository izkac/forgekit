# Delta for session-score

## ADDED Requirements

### Requirement: Caps distinguish applied reductions from notes

Each entry in a scorecard's `caps` array SHALL be an object
`{ id, applied, before, after, text }` (or a legacy string from older
ledgers). When a cap condition is observed but the score is not lowered,
`applied` SHALL be false. Fleet aggregation SHALL treat a session as capped
only when at least one entry has `applied: true` (legacy strings count as
applied).

#### Scenario: Noted cap does not mark capped

- GIVEN a session whose score is already at or below the outcome cap
- AND a high-risk / health condition would have capped it
- WHEN the scorecard is written and fleet report aggregates it
- THEN the caps entry has `applied: false`
- AND the session is not counted in fleet `totals.capped`

#### Scenario: Applied cap lowers score and marks capped

- GIVEN a session scoring above the outcome cap that triggers a real cap
- WHEN the scorecard is written
- THEN score equals the cap ceiling
- AND the caps entry has `applied: true` with before/after reflecting the
  reduction
