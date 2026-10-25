# Delta for session-metrics

## ADDED Requirements

### Requirement: The digest records the forgekit version and models by role
Each `sessions.jsonl` digest SHALL carry `forgekitVersion` (the CLI package version that wrote it)
and `models: { coordinator, subagents }` listing the models seen in the coordinator transcript and
in subagent transcripts. Where the host does not separate them, both lists SHALL be `null`.

#### Scenario: Separable host
- GIVEN a session whose coordinator ran on one model and whose subagents ran on another
- WHEN the digest is written
- THEN `models.coordinator` and `models.subagents` list them separately and `forgekitVersion` is set

#### Scenario: Host without separable transcripts
- GIVEN a host whose transcripts do not mark subagent requests
- WHEN the digest is written
- THEN `models.coordinator` and `models.subagents` are `null`
