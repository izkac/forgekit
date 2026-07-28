# 0003. Session telemetry reads the host's transcripts; Forge records nothing

- **Status:** Accepted
- **Date:** 2026-07-28
- **Area:** session telemetry / metrics
- **Related:** `specs/changes/archive/2026-07-28-session-telemetry/`, [0004](0004-usage-counted-once-per-request.md)

## Context

A Forge session recorded how *disciplined* it was — score, reviews, deferrals —
and nothing about how it *ran*. Tokens, models, failing tools, how much work was
delegated to subagents, and whether `forge resolve-model` was honoured were all
invisible, so every claim about workflow or model quality was an impression.

Claude Code already writes every request to a JSONL transcript at
`~/.claude/projects/<munged-cwd>/<host-session-id>.jsonl`, with subagent
sidecars beside it. The only missing link was knowing *which* transcripts belong
to which Forge session — and `CLAUDE_CODE_SESSION_ID`, whose value is the
transcript's basename, is already exported into the shell `forge` runs in.

## Decision

Forge is a **reader**, never a recorder.

1. **Binding is environmental, not instrumented.** `bindHost` reads
   `CLAUDE_CODE_SESSION_ID` on every `forge new` / `forge phase` and appends to
   `session.host.sessionIds`. No hook is required; a session resumed under a new
   host session appends rather than replaces; a command run outside a host never
   erases an existing binding.
2. **Nothing is written on the request path.** No wrapper, no hook, no counter
   incremented as work happens. Metrics are harvested afterwards by
   `forge metrics collect`, and automatically at `forge phase finish|done`.
3. **Telemetry is advisory, absolutely.** Collection, dispatch logging and digest
   enrichment SHALL NOT throw, alter a hook decision, or block a phase
   transition. Every failure — no binding, pruned transcript, corrupt file —
   degrades to `{available: false, reason}` and exits 0.
4. **Counts, never content.** Persisted metrics contain counts, model slugs, tool
   names, agent types, phase names and timestamps. Prompt text, model responses,
   command strings, file contents and a subagent's `description` are never
   written. `metrics.json` outlives the conversation; it holds arithmetic.
5. **Totals must outlive the session directory.** A compact block goes into
   `.forge/sessions.jsonl`, because `forge cleanup` deletes everything else.

`findTranscripts` globs `projects/*` rather than reconstructing the munged
directory name: that munging rule is undocumented, and host session ids are
unique anyway.

## Alternatives considered

- **Hook-instrumented recording** (PreToolUse/PostToolUse writing counters as
  work happens). Rejected: it requires per-project wiring to produce any data at
  all, puts Forge on the critical path of every tool call, and would still miss
  token usage, which hooks never see. The host already has the numbers.
- **Reconstructing the transcript path from the cwd munge.** Rejected: undocumented
  and version-dependent. A glob over unique ids is both exact and immune to it.
- **Trusting `AI_AGENT`** to identify the host. Rejected: its shape
  (`claude-code_2-1-220_agent`) is version-dependent and not a contract. The
  presence of a session id decides.
- **Time-window inference for sessions that predate binding.** Rejected: bind
  forward only. Attributing a transcript to a session on timing alone invents
  measurements.

## Consequences

- **Positive:** Works with zero project wiring; measures what actually happened
  including subagent cost, which is where most tokens go (75% on the change that
  introduced this). Costs nothing at runtime.
- **Positive:** `available: false` is a first-class, honest outcome — running
  under Cursor, Codex or a plain shell is normal, not an error.
- **Negative:** Claude Code only. Other hosts report `agent: unknown` and no
  metrics until an adapter is written.
- **Negative:** Depends on an undocumented on-disk format. `hostVersion` is
  recorded in every document, degraded ones included, so a format break is
  diagnosable rather than merely puzzling.
- **Neutral:** Sessions that ended before this shipped stay unmeasured forever.
  `forge analyze` states coverage first so a partial history is never read as a
  complete one.

## References

- Archive: `specs/changes/archive/2026-07-28-session-telemetry/`
- Specs: `specs/specs/session-metrics/spec.md`, `specs/specs/session-analysis/spec.md`
- Code: `packages/cli/src/metrics/host.mjs`, `metrics/collect.mjs`,
  `metrics/dispatches.mjs`, `analyze.mjs`
