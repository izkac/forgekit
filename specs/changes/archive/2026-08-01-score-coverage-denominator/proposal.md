# Score coverage denominator + structured caps

## Why

Finding **F16**: `collectPlanFacts().groups` counts every `##` line in
`tasks.md`. A `## Notes` section or a heading inside a fenced code block
inflates the review-depth denominator without changing any work. Headingless
plans already fall back to one group via `Math.max(groups, 1)` (F13 work);
the remaining defects are false positives on real headings.

Finding **F14**: `score.mjs` pushes a `caps` string even when the score was
already at or below the cap (nothing applied). `fleet-report.mjs` treats any
non-empty `caps` array as `capped:true`, so informational notes look like
process failures.

## What Changes

- Parse `tasks.md` groups by: strip fenced code blocks, then count only
  numbered task-group headings (`## N. …` / `## N) …`). Free-form `## Notes`
  does not count. Headingless readable plans with tasks still report
  `groups: 0` from the parser; scorer keeps `Math.max(groups, 1)`.
- Cap entries become structured objects
  `{ id, applied, before, after, text }`. Only `applied: true` lowers the
  score and counts as capped in fleet totals. Noted (non-applied) entries
  stay visible but do not set `capped:true`.
- Resolve F16 and F14.

## Capabilities

- `plan-facts`: group counting ignores fences and non-group headings
  (delta: `specs/plan-facts/spec.md`)
- `session-score`: structured caps distinguish applied vs noted
  (delta: `specs/session-score/spec.md`)

## Impact

- Code: `packages/cli/src/plan-facts.mjs`, `score.mjs`, `fleet-report.mjs`
  (+ tests). Scorecard / digest consumers that assume `caps: string[]` must
  accept objects (render `text`; treat missing `applied` as applied for
  legacy ledger lines).
- Risk: tightening group headings could under-count oddly formatted plans
  that used `## Group name` without a number — those plans already diverge
  from Forge task templates; numbered headings are the endorsed shape.
- Migration: none for live sessions; old scorecards.jsonl lines with string
  caps remain readable.
- Findings: resolve F16, F14.
