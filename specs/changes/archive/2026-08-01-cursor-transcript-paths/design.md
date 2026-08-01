# Design — cursor-transcript-paths (F71)

## Layout

```
~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl
~/.cursor/projects/<slug>/agent-transcripts/<id>/subagents/
```

`opts.cursorProjectsDir` overrides `~/.cursor/projects` for tests (mirror
`configDir` for Claude).

## findTranscripts

For each id not found under Claude projects, scan Cursor projects the same way
(found / unreadable / omit). Claude hit still wins if both exist.

## collectMetrics honesty

If bound files are readable but `usageByRequest` yields no entries (Cursor
`{role,message}` lines lack `type`/`usage`), return degraded with a reason that
includes the transcript path and states the host format has no token usage —
not "pruned or written elsewhere". Prefer this over "outside session window"
when lines lack timestamps entirely.

## Out of scope

Parsing Cursor role/message into fake token totals.
