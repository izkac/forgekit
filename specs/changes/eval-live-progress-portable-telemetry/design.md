# Design

## Context

`run.mjs` intentionally reserves stdout for a final JSON plan and redirects Harbor streams into per-trial logs. That keeps automation reliable but makes a healthy multi-minute run look hung. Forge artifact discovery currently records the host-absolute discovery path in `forge-summary.json`, which then passes through the normalizer.

## Decisions

- Decision: write progress only to stderr.
  - Emit run start, trial start, periodic `still running` heartbeat, and terminal trial/run messages containing only safe run/trial/task ids, arm, ordinal, status, trial counts, outcome counts, and elapsed seconds.
  - Rationale: stdout remains parseable and progress cannot leak task source, credentials, or host paths.
- Decision: expose `--progress-interval-seconds` from 0 through 86400, default 30; `0` disables heartbeats but not lifecycle events.
  - Rationale: production behavior is useful by default and tests can exercise short intervals without hidden environment hooks.
- Decision: store `artifactLocator` relative to the trial Harbor output root and remove `artifactPath`.
  - Rationale: consumers need a portable locator plus the already-relative file list, not a host location.
- Decision: retain normalized schema version 1 because the Forge telemetry object is optional secondary instrumentation and no released consumer contract requires `artifactPath`.

## Risks / Trade-offs

- Concurrent pair blocks can interleave stderr; every line therefore includes run and trial identity.
- Heartbeats add small output volume and use monotonic elapsed time only for display.
- Existing local normalized records keep their old field; new records use the portable field.
