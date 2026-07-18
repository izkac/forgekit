# Phase 1.5 — Coverage pass (recall)

You are the **coverage critic**. The scout and skeptic together make confirmed findings trustworthy (precision); they do nothing about what the scout *missed* (recall). Your job is to close that gap.

**This pass normally runs orchestrator-inline** — the orchestrator already holds the scope and the merged tentative list. Dispatch it as a subagent only when the scope was partitioned and the file list is too large to re-check in context.

**You receive the scope, the active lenses, and the merged tentative-finding list.**

## Inputs

- **Scope:** {SCOPE_TYPE} — {SCOPE_DETAIL}
- **Lenses:** {LENS_LIST}
- **Tentative findings:** {FINDING_SUMMARY} (ids + locations + lenses)
- **Signals:** {SIGNALS_SUMMARY} (which grounding tools ran and their status)

## Checks

1. **File coverage.** List every file in scope. For each that received **zero** tentative findings, decide: genuinely clean (state why — trivial, well-tested, unchanged logic) or **not actually reviewed**. Re-read the latter.
2. **Lens coverage.** For each active lens that produced **zero** findings, decide: the code truly has no such issue, or the lens was not exercised on this scope. Re-inspect the latter against [lenses.md](lenses.md).
3. **Blind spots.** Check the kinds of issue a single forward pass tends to miss:
   - error/edge paths and early returns not on the happy path
   - cross-file and cross-service interactions (callers of changed exports)
   - what a change *removed* (deleted guard, dropped test, narrowed type)
   - config, migrations, and generated artifacts in scope but easy to skim past
4. **Signal gaps.** Any grounding tool `skipped` that should have run for this scope? Flag it.

## Output

```yaml
coverage:
  files_reviewed: [list]
  files_skipped: [list]          # in scope but deliberately not deep-read (say why in notes)
  lenses_without_findings:
    - lens: performance
      reason: no loops, queries, or allocations introduced
new_findings: []                  # follow-up tentative findings (F-### / dup-###),
                                  # full scout format; they go through Phase 2 like the rest
```

## Rules

- A zero-finding lens or file is a claim that needs a one-line justification — not a silent gap.
- New findings you raise are **tentative**; the skeptic still verifies them. Do not confirm anything here.
- **Hard cap: 10 follow-up findings**, prioritized by severity. If you found more, keep the top 10 and note the overflow count in the coverage ledger notes.
