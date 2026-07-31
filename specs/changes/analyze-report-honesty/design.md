# Design — analyze-report-honesty

## Context

`buildAnalysis` joins `sessions.jsonl` digests with optional live
`metrics.json`. Digests today keep totals + model *names* via
`compactMetrics`; token splits live only in the full document and die at
`forge cleanup`. The Model-policy line branches only on `d.total`. Collection
treats `<synthetic>` as a real model slug.

## Decisions

### Digest schema extension (F66)

`compactMetrics` gains optional `byModel` and `byPhase` maps. Each cell keeps
the numeric fields analyze already reads from the full doc (`requests` +
token fields). Absence means “predates this change” — analyze treats that like
today’s name-only digest (sessions/grades only for that model).

When both live doc and digest splits exist, prefer the live doc (freshest).
When only digest splits exist, sum those into `byModel`/`byPhase` and set
`detailed` to count sessions that contributed splits (not “metrics.json
exists”).

### Model policy copy (F65)

| Condition | Message |
| --------- | ------- |
| `d.sessions === 0` | advise wiring PreToolUse (`forge init`) |
| `d.sessions > 0 && d.total === 0` | N sessions reported no dispatches |
| `d.total > 0` | existing breakdown + skip rate |

### Synthetic filter (F69)

In transcript summarisation (where `byModel` keys are assigned), skip the
literal model slug `<synthetic>`. Do not rewrite historical digests.

### Dogfood wiring (F64)

Commit `.claude/hooks/` from templates and `.claude/settings.json` with the
hooks from `forge-hooks.snippet.json` merged so PreToolUse is active when
Claude Code runs in this checkout. Cursor agent work remains a separate
measurement path (out of scope for F64).

### Renderer (F67, F68)

Update the By-model caption to state that `requests` / token columns /
`sess err` cover only sessions with a detailed split; `sessions` and `grades`
are digest-wide. Column header `err` → `sess err`.

## Risks

- Digest lines grow slightly — acceptable per finding (~hundreds of bytes).
- Claude-only dogfood does not populate dispatch tables for Cursor Task
  runs in this repo; F64 still satisfies the finding as written.
- Historical digests still list `<synthetic>` in `models[]` — analyze may
  still show a row for those until we also filter at *read* time. Prefer
  also skipping `<synthetic>` when naming models in `buildAnalysis` so the
  table stops grading the sunk name without rewriting jsonl.
