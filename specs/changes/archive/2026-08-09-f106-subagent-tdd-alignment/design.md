# Design

## Decisions

- Keep `checkTddEvidence` unchanged: an ok expected RED must precede an ok GREEN for identical argv.
- Subagents always use `--session {SESSION_ID} --task {TASK_ID}` and report `.forge/sessions/{SESSION_ID}/tasks/{TASK_ID}/tdd-runs.jsonl`.
- In a `features.tddEvidence` session, plain `forge evidence` without `--no-tdd` is refused only while the task lacks a TDD ledger. Once a ledger exists, plain evidence remains valid supplemental detail and the done gate still validates the pair.
- `forge tdd run` prints the stamp path, expectation, child exit, and outcome after every written stamp.

## Non-goals

No reviewer-attestation format, reconstructed historical stamps, or weaker evidence acceptance.
