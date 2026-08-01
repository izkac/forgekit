# Delta for review-evidence

## ADDED Requirements

### Requirement: Rejection census ignores instructional REJECT prose

`reviewCensus` SHALL increment `rejections` for a review file only when the
body contains a structural rejection marker — a `Round <n> … REJECTED` line
or a `**Verdict: REJECTED**` heading — not merely the token `REJECT` in
instructional text such as "REJECT if any of".

#### Scenario: REJECT-if instructions with APPROVED do not count

- GIVEN a group-review.md that contains `REJECT if any of:` and ends
  APPROVED with no Round REJECTED marker
- WHEN `reviewCensus` runs
- THEN that file does not increment `rejections`

#### Scenario: Real rejection round still counts

- GIVEN a group-review.md containing `## Round 1 — REJECTED`
- WHEN `reviewCensus` runs
- THEN `rejections` increments by at least 1 for that file
