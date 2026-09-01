# Delta for Session Analysis

## ADDED Requirements

### Requirement: Brief stamp counters as a spec-churn proxy

`forge brief stamp` SHALL increment `session.briefStamps` on every successful
stamp and, when the session's phase history already contains `implement`, also
increment `session.briefRestampsAfterImplement`.

#### Scenario: Re-stamp after implement counts as churn

- GIVEN a session whose brief was stamped once before implement began
- WHEN the specs are edited during implement and `forge brief stamp` runs again
- THEN `briefStamps` is 2 and `briefRestampsAfterImplement` is 1

### Requirement: Brainstorm signals in the session ledger

The sessions.jsonl digest row SHALL additively carry `briefStamps`,
`briefRestampsAfterImplement`, and `brainstorm: { notes, assumptions,
adrCandidates }` — whether `brainstorm/notes.md` exists, the count of `- `
bullets under its `## Assumptions` heading, and the count of `ADR-candidate:`
entries in `brainstorm/decisions.md`. The parser SHALL never throw; when the
session directory or files are gone the fields default to null/zero. Scoring
(`forge score`) SHALL be unchanged by this requirement.

#### Scenario: Digest row carries the signals

- GIVEN a done session with notes.md holding three Assumptions bullets and one
  ADR-candidate decision
- WHEN the digest row is appended
- THEN the row shows `brainstorm.assumptions` 3 and `brainstorm.adrCandidates` 1

#### Scenario: Cleaned-up session degrades gracefully

- GIVEN a session dir already removed by cleanup
- WHEN the digest row is rebuilt
- THEN the brainstorm fields are null/zero and no error is raised

### Requirement: Analyze surfaces churn and ledger aggregates

`forge analyze` SHALL carry the new fields on its per-session rows and its
totals SHALL include the number of sessions with post-implement re-stamps and
the mean assumptions count across sessions that have a ledger; the text output
SHALL include one summary line for them.

#### Scenario: Aggregate line appears

- GIVEN sessions.jsonl rows where one session re-stamped after implement
- WHEN `forge analyze` runs
- THEN totals report one spec-churn session and the summary line prints it
