# Session Telemetry

## Why

A finished Forge session records how *disciplined* it was — score, deductions,
review census, deferrals — and nothing about how it actually ran. Nobody can
answer, from the record, how many tokens a session burned, which models did the
work, how often tools failed, or where the effort went. `subagentsDispatched` has
been `null` in every digest since the ledger was introduced.

That gap blocks the two questions this project keeps asking about itself: *is
the workflow getting better?* and *are the models doing good work?* Both need
numbers over time, and the numbers are not being kept.

They are, however, already being written. The Claude Code transcript records
per-request token usage, the resolved model, effort, timestamps, and tool
failures; subagents get sidecar transcripts carrying their agent type and
dispatched model. `CLAUDE_CODE_SESSION_ID` is exported into the shell Forge runs
in, so a session can bind itself to its transcript with no hook wiring at all.
The work is not to instrument Forge — it is to read what the host already wrote,
before `forge cleanup` deletes the session and the transcript ages out.

One thing the transcript cannot show is dispatch enforcement: a denied dispatch
leaves no sidecar, and a rewritten one erases what the coordinator originally
asked for. That is exactly the measurement needed for the known problem that
`forge resolve-model` gets skipped, so `forge enforce-model` — which already
sees every dispatch — logs its own decisions.

## What Changes

- **Host binding.** `session.json` gains `host: {agent, sessionIds[], boundAt}`,
  populated from the environment at `forge new` and appended-if-new on later
  commands. Transcripts are located by scanning
  `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/*/<sessionId>.jsonl`.
- **Phase history.** `session.json` gains `phaseHistory: [{phase, at}]`, the join
  key for per-phase attribution.
- **Collector.** `forge metrics collect` reads the bound transcripts and their
  subagent sidecars, dedupes usage by `requestId`, filters to the session's time
  window, and writes counts-only `metrics.json` into the session directory. Runs
  automatically on `forge phase finish|done`, before the scorecard.
- **Dispatch ledger.** `forge enforce-model` appends one line per decision
  (requested model, resolved model, allowed / rewritten / denied) to
  `dispatches.jsonl` when a Forge session is active.
- **Digest enrichment.** `sessions.jsonl` carries a compact `metrics` object, so
  the numbers survive `forge cleanup` deleting the session directory.
- **Read side.** `forge analyze [--json]` emits deterministic aggregates to
  stdout: coverage, per-session table, by-model, by-phase, enforcement skip rate.
  The existing `/forge:analyze` command consumes it instead of eyeballing
  session directories.

Not in scope, deliberately: cost/pricing, backfill of pre-binding sessions,
Cursor/Codex adapters, trend and regression detection. Metrics do **not** feed
the scorecard — discipline and cost stay separate measurements.

## Capabilities

- `session-metrics`: bind a Forge session to its host transcripts, harvest
  counts-only usage/model/error metrics, and persist them where they survive
  session cleanup.
- `session-analysis`: read the durable ledgers back as deterministic aggregates
  for workflow and model-quality review.

## Impact

**Affected code** — `packages/cli/src/metrics/` (new), `analyze.mjs` (new),
`metrics-cli.mjs` (new), `enforce-model.mjs`, `set-phase.mjs`, `new-session.mjs`,
`ledger.mjs`, `lib.mjs`, `bin/forge.mjs`,
`templates/project/claude/commands/forge-analyze.md`, docs.

**Data contracts** — additive only: two new `session.json` fields, one new
`sessions.jsonl` field, two new files inside the session directory. Existing
readers are unaffected; sessions without the new fields stay valid.

**Risks**

- *The transcript layout is not a public contract.* A future Claude Code release
  could change it. Contained by an adapter boundary, by recording the observed
  host `version` in every digest, and by degrading to `available: false` with a
  reason rather than guessing. A format break loses telemetry; it cannot break
  Forge.
- *Silent over-counting.* Usage repeats on every content-block line of the same
  request — measured at 39 lines for 12 requests. Dedupe by `requestId` carries
  its own regression test.
- *Telemetry blocking work.* Every path is advisory and wrapped: collection
  failure, an unreadable or pruned transcript, or a failed dispatch-log write
  must never change a hook decision or block a phase transition — the contract
  already stated in `ledger.mjs`.

**Privacy** — counts, model slugs, tool names, agent types, phase names and
timestamps only. No prompts, responses, command strings, or file contents. The
subagent `description` field is deliberately not recorded.

## Decision record

This change is recorded as ADR-0003 (`docs/adr/0003-telemetry-reads-host-transcripts.md`)
and ADR-0004 (`docs/adr/0004-usage-counted-once-per-request.md`).
