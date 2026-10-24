# Delta for Session Lifecycle

## ADDED Requirements

### Requirement: Done records the change's commit range
When `forge phase done` succeeds, the system SHALL record the change's Commit range as
`{ base, head }` — `base` the session's `baseCommit`, `head` the repository HEAD at the transition —
on the session, in its `.forge/sessions.jsonl` digest row (`commitRange`), and in its fleet
registry entry (`commitRange`). A refused transition SHALL record no range. A session without a
`baseCommit`, or outside a git repository, SHALL carry no `commitRange` rather than a partial one.

#### Scenario: Done writes the range everywhere
- GIVEN a session in a git repository with `baseCommit` B and HEAD H
- WHEN `forge phase done` succeeds
- THEN `session.json`, the `sessions.jsonl` row and the fleet entry each hold `commitRange: { base: B, head: H }`

#### Scenario: Refused done records nothing
- GIVEN a session whose done gate refuses
- WHEN `forge phase done` exits non-zero
- THEN no `commitRange` is written
