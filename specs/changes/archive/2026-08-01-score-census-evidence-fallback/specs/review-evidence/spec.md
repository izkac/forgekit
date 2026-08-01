# Delta for review-evidence

## ADDED Requirements

### Requirement: Live score/ledger census consults host evidence

When `forge score` or the session digest computes a live `reviewCensus`
because no frozen verdict exists on the session, it SHALL pass host
`reviewEvidence` into `reviewCensus` the same way `forge phase done` does.
A dispatch stamp alone SHALL NOT outrank a host-measured stop on that path.

#### Scenario: Live census sees a measured stop

- GIVEN a session with no frozen reviewVerdict
- AND a final dispatch stamp exists
- AND reviewEvidence reports a measured operator stop for final
- WHEN forge score runs
- THEN finalReviewEvidence is not graded `recorded` solely from the stamp
  in a way that ignores the stop
