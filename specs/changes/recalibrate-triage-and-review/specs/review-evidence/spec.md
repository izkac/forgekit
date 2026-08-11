# Delta for Review Evidence

## ADDED Requirements

### Requirement: Review yield is reportable per pace
`forge analyze` SHALL report, for each resolved pace, the number of sessions,
total tasks, independent reviews, reviews per task, rejections, and rejections
per one hundred tasks. The figures SHALL come from Forge's own recorded review
stamps.

#### Scenario: The yield table is produced

- **GIVEN** a session ledger containing sessions at more than one pace
- **WHEN** `forge analyze` runs
- **THEN** its output contains one yield row per pace present
- **AND** each row reports reviews per task and rejections per hundred tasks

#### Scenario: A pace with no recorded sessions is omitted

- **GIVEN** a ledger with no sessions at a given pace
- **WHEN** `forge analyze` runs
- **THEN** no row is emitted for that pace

### Requirement: Harvested dispatch counts never stand in for review stamps
Review-yield figures SHALL be derived from recorded review stamps and SHALL NOT
fall back to harvested host dispatch counts. Where harvested telemetry is
missing, it SHALL be reported as missing rather than as zero reviews.

#### Scenario: Failed telemetry collection does not read as zero reviews

- **GIVEN** a session whose host metrics collection failed but which recorded
  independent reviews
- **WHEN** the yield table is produced
- **THEN** its recorded reviews are counted
- **AND** the missing harvested telemetry is not counted as zero

### Requirement: A pre-change yield baseline is recorded with the change
The change that alters review cadence SHALL record the yield table measured
before the change inside its own change directory, so the effect of the change
can be compared against a fixed reference rather than a recollection.

#### Scenario: Baseline is present and dated

- **GIVEN** the recalibration change directory
- **WHEN** its baseline record is read
- **THEN** it contains the per-pace yield table
- **AND** it names the session ledgers and the date it was measured
