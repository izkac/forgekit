# Design — cost-levers

## Context
Cost ≈ requests × context per request (cache reads are 97.7% of tokens). Two ways to cut it
without touching quality: fewer dispatches doing the same work, and less context carried by
the coordinator. A third saves rework: fewer false reviewer claims to refute.

## Decisions
- **Warn, never block, on budget.** A refused dispatch could be a review that quality depends
  on. Alternatives: hook denial (rejected: hooks must stay silent or deny-only, and a denial
  here would trade quality for cost).
- **Count dispatches from the log the model hook already writes**
  (`.forge/sessions/<id>/dispatches.jsonl`, one line per dispatch with `decision`). No hook
  change. Known limit: the hook credits the checkout's *active* session, so a second
  session running from the same folder inflates the count (finding filed); the plan-time
  projection is unaffected.
- **Projection from the plan.** Work units = `tasks.md` groups split at ≤4 tasks, 1:1 for
  high-risk tasks (the existing work-unit rule), plus group reviewers per the resolved pace's
  `review.perTask`, plus one final review. Reuses `plan-facts.mjs` parsing.
- **Three evidence forms for a blocking claim:** failing command; spec quote + missing
  location; concrete scenario + location + expected/actual. The third keeps real defects
  that no spec line or command shows yet. An unbacked item is downgraded, never deleted.
- **Known-false filtering by basename substring** over claim/actual text. The ledger has no
  path field; adding one is not worth a format change for a relevance filter.
- **Measure coordinator context before deeper cuts.** Split coordinator vs subagent requests
  per group from host transcripts (sidechain transcripts are separate files); `null` when the
  host cannot tell them apart.
- **`forge group close`** composes the existing steps (checkpoint, range, precheck, label) and adds
  no new review rules. Range and precheck run in-process; checkpoint and label are spawned as their
  own CLIs (both are `process.exit` scripts and the label step stamps the dispatch). It validates the
  unit name and precheck before committing, and a retry keeps the group's whole range.
- **Short output is opt-in (`--brief`)** for `forge phase` and `forge status`; JSON stays the
  default. Changed during implement: 6 test files and 3 e2e scripts parse the default JSON,
  and short output saves ~1% of a request's context — not worth a breaking change.

## Risks
- Reviewers may pad evidence lines to avoid downgrades. Mitigation: `review-check` requires
  a structural match (argv + exit code, or quote + file reference, or scenario + file:line),
  and the census keeps counting refuted claims, so padding shows up as refutations.
- The 10-line reply limit is advisory; the new metrics show whether it holds.
