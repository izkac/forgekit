# Delta for session-metrics

## ADDED Requirements

### Requirement: Cursor host transcripts are locatable

`findTranscripts` SHALL locate Cursor conversation transcripts under
`~/.cursor/projects/*/agent-transcripts/<sessionId>/<sessionId>.jsonl` when
they are not present under Claude's projects tree. A missing Claude path alone
SHALL NOT be reported as "pruned or written elsewhere" when the Cursor path
exists.

#### Scenario: Cursor transcript is found outside Claude projects

- GIVEN a host session id whose only transcript is under Cursor agent-transcripts
- WHEN findTranscripts runs
- THEN the id appears in `found` with that transcript path

### Requirement: Found-but-unusable Cursor transcripts degrade honestly

When a bound transcript is located but yields no Claude-format token usage,
`collectMetrics` SHALL degrade with a reason that names the located path and
that the host format lacks token usage, and SHALL NOT use the
"pruned or written elsewhere" wording.

#### Scenario: Cursor role/message transcript is not a prune

- GIVEN a found Cursor transcript with role/message lines and no usage fields
- WHEN collectMetrics runs
- THEN available is false
- AND reason mentions the transcript path and lack of token usage
- AND reason does not say pruned or written elsewhere
