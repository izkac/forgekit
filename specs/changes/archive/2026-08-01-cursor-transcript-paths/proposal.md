# Cursor Transcript Paths

## Why

Cursor-bound Forge sessions record a host id, but `findTranscripts` only
searches Claude's `~/.claude/projects/`. The real Cursor transcript lives under
`~/.cursor/projects/*/agent-transcripts/<id>/`. Collection then reports
"pruned or written elsewhere" for sessions whose transcript is present (F71).

## What Changes

- `findTranscripts` also locates Cursor agent-transcripts (+ subagents dir)
- When a transcript is found but has no Claude-format token usage, degrade with
  an honest format reason (never the prune wording)

## Capabilities

- `session-metrics`: Cursor transcript location (delta: `specs/session-metrics/spec.md`)

## Impact

Metrics/review evidence for Cursor hosts. No full Cursor token parser yet —
Cursor JSONL does not emit usage today.
