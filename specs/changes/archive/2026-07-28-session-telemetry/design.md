# Design

## Context

Measured on this machine against Claude Code 2.1.220 — these are observations,
not assumptions, and each one moved the design:

1. **The host transcript already holds the data.**
   `~/.claude/projects/<munged-cwd>/<session-id>.jsonl` records per assistant
   message: `message.model` (resolved slug), `message.usage` (`input_tokens`,
   `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`),
   `effort`, `timestamp`, `cwd`, `gitBranch`, `version`. Tool failures appear as
   `is_error: true` on `tool_result` content blocks.

2. **Subagents write sidecar transcripts.**
   `<session-id>/subagents/agent-<id>.jsonl` with an `agent-<id>.meta.json`
   carrying `{agentType, description, toolUseId, spawnDepth, model}`. The
   sidecar's assistant lines hold the resolved slug (`claude-opus-5`); the meta
   holds the dispatched alias (`opus`). Sidecars were present across four
   unrelated projects on this machine, so the mechanism is stable rather than
   incidental.

3. **`CLAUDE_CODE_SESSION_ID` is exported into the Bash environment**, verified
   equal to the current session's transcript basename. Alongside it:
   `AI_AGENT=claude-code_2-1-220_agent`, `CLAUDECODE`, `CLAUDE_EFFORT`.

4. **Usage is duplicated per content block.** One assistant *request* writes one
   transcript line per content block (thinking, text, each `tool_use`), every
   line repeating the same `requestId` and the same `usage` object. Measured: 39
   assistant lines for 12 distinct requests.

5. **`/forge:analyze` already exists** as an LLM-driven narrative command over
   `scorecards.jsonl`.

## Decisions

- **Decision: harvest the transcript post-hoc; do not instrument with hooks.**
  - Alternatives considered: a live event stream via new PostToolUse /
    SubagentStop / Stop hooks appending to `metrics.jsonl`.
  - Rationale: the host already writes everything the hooks would record, so
    instrumentation would duplicate it while adding three hooks every project
    must wire and keep wired. It would also inherit the failure mode already
    recorded against `forge resolve-model` — a step that depends on being
    invoked correctly gets skipped in the field. A reader has no such
    dependency: it reads what actually happened, not what a cooperating caller
    reported.

- **Decision: bind via `CLAUDE_CODE_SESSION_ID` from the environment.**
  - Alternatives considered: recording `session_id` / `transcript_path` from a
    SessionStart hook payload.
  - Rationale: SessionStart fires before a Forge session may exist — this very
    change was planned in a host session that predated `forge new`. Reading the
    env at each `forge` invocation binds correctly whenever the session is
    created, and needs nothing installed.

- **Decision: locate transcripts by scanning `projects/*/<sessionId>.jsonl`.**
  - Alternatives considered: reimplementing the cwd → directory-name munge.
  - Rationale: the munge rule (`/` → `-`) is inferred from one sample and is not
    documented. Session ids are unique, so a scan is exact and survives any
    change to how the host names project directories. `CLAUDE_CONFIG_DIR` is
    honoured when set.

- **Decision: dedupe usage by `requestId` (then `message.id`, then per line).**
  - Alternatives considered: summing every assistant line.
  - Rationale: summing lines inflates tokens roughly 3× on measured data, and
    inflates it *plausibly* — the number looks reasonable and is simply wrong.
    This gets a dedicated regression test rather than a comment.

- **Decision: keep both the binding and a time window.**
  - Alternatives considered: binding alone.
  - Rationale: one host session commonly spans several sequential Forge
    sessions. Binding selects the files; `[createdAt, collectedAt]` selects the
    lines.

- **Decision: log dispatch decisions inside `forge enforce-model`.**
  - Alternatives considered: deriving dispatch facts from subagent `meta.json`.
  - Rationale: a denied dispatch never creates a sidecar and a rewritten one
    erases the coordinator's original choice, so sidecars cannot measure the
    skip rate. Logging happens whenever a Forge session is active — including
    when `models.local.json` is absent — because the skip rate is worth knowing
    *before* enforcement is switched on. The active-session condition keeps the
    log bounded and project-scoped.

- **Decision: the CLI prints numbers; `/forge:analyze` writes the report.**
  - Alternatives considered: a CLI that writes `.forge/reports/` itself.
  - Rationale: `/forge:analyze` already owns that file. Two writers would
    compete; instead the command's Gather step consumes `forge analyze --json`.

- **Decision: metrics never feed the scorecard.**
  - Alternatives considered: folding token cost into the score.
  - Rationale: the scorecard measures discipline. Making cheap sessions score
    higher would create pressure to downgrade models, contradicting the
    project's model policy. Cost and discipline stay separate readings.

- **Decision: counts only; no `description`, no prompts, no command strings.**
  - Alternatives considered: recording the subagent `description` for
    readability.
  - Rationale: `description` is free-form text authored at dispatch time and can
    contain anything; `agentType` answers the same question without carrying
    content into a file that outlives the session.

- **Decision: add `phaseHistory: [{phase, at}]` to `session.json`.**
  - Alternatives considered: inferring phases from git history or file mtimes.
  - Rationale: only the current phase is kept today, so per-phase attribution
    has no join key. Transition timestamps are cheap to append and independently
    useful for duration reporting.

## Risks / Trade-offs

- **The transcript layout is not a public contract.** A Claude Code release could
  change field names or file placement. Contained by keeping all format
  knowledge behind `metrics/transcript.mjs`, recording the observed host
  `version` in every digest so a break is diagnosable, and degrading to
  `available: false` with a reason instead of guessing. Accepted: telemetry can
  regress, Forge cannot.
- **Claude Code only.** Cursor and Codex sessions record `agent: "unknown"` and
  no metrics. `forge analyze` states coverage ("6 of 9 sessions have metrics")
  up front so a partial history is never read as a complete one. Adding an
  adapter later is additive.
- **Retention race.** Host transcripts age out (30 days by default) and Forge
  sessions are pruned at 14. Collection runs at `finish`/`done`, well inside
  both windows; sessions that end without either transition simply have no
  metrics.
- **Advisory everywhere.** Collection, logging and digest enrichment are wrapped
  so no failure can change a hook decision or block a phase transition. The
  cost is that a silent failure is possible; `available: false` with a reason
  makes it visible in `forge analyze` rather than hidden.
