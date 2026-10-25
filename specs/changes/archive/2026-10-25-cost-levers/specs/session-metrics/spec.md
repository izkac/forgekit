# Delta for session-metrics

## ADDED Requirements

### Requirement: Coordinator and subagent requests are reported apart
Collected metrics SHALL report coordinator requests and subagent requests separately, per
`tasks.md` group where the time of the request falls inside the group's window, and SHALL
report mean context tokens per coordinator request. Where the host's transcripts cannot
tell coordinator from subagent, these fields SHALL be `null`, never estimated.

#### Scenario: Claude Code host
- GIVEN a session with a coordinator transcript and two subagent transcripts
- WHEN metrics are collected
- THEN coordinator and subagent request counts are reported separately with a per-group split

#### Scenario: Host without separable transcripts
- GIVEN a host whose transcripts do not mark subagent requests
- WHEN metrics are collected
- THEN the split fields are `null`
