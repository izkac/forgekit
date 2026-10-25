# Cut Forge's time and token cost without lowering quality

## Why
Volo's 62 measured sessions show where Forge's cost goes. 97.7% of tokens are cache reads,
so cost is roughly model requests × context carried per request (median session: 137M
tokens over 673 requests). The implement phase takes 76% of tokens. Sessions with 40+
subagents cost about 19M tokens per task against 7–9M under 20, with no better scores.
Reviewers raised 166 claims that were later refuted, against 61 rejections that held, and
each false claim costs the coordinator a refutation round.

None of the fixes may weaken a check: no model, tier or pace-rule changes, no skipped
reviews.

## What Changes
- **Subagent budget:** `forge phase implement` projects the session's dispatches from
  `tasks.md` and warns when the projection exceeds `budget.subagents` (default 15).
  `forge status` and the session reminder show the running count from the dispatch log the
  model hook already writes. Never blocks a dispatch.
- **Backed review claims:** reviewer prompts require evidence on every Critical/Important
  item (failing command, spec quote + location, or concrete scenario + location). New
  `forge review-check` downgrades unbacked blocking items to Minor; only backed items start
  a fix round or count as a rejection.
- **Refuted claims in reviewer briefs:** `forge refute list --md --for-diff <range>` fills a
  new `{KNOWN_FALSE}` block in reviewer briefs with this session's refutations plus up to 20
  project entries that mention changed files.
- **Coordinator context:** metrics split coordinator from subagent requests per task group
  and record mean context per coordinator request; subagents reply with a status line plus
  ≤10 lines; new `forge group close` replaces four group-boundary calls with one;
  `forge phase` and `forge status` print a short summary unless `--json`.

## Capabilities
- `dispatch-budget`: new — projection, silent dispatch log, budget display — delta at `specs/dispatch-budget/spec.md`
- `review-claims`: new — evidence-backed blocking claims, known-false in reviewer briefs — delta at `specs/review-claims/spec.md`
- `session-metrics`: coordinator vs subagent split per group — delta at `specs/session-metrics/spec.md`
- `session-progress`: `forge group close`, short default output — delta at `specs/session-progress/spec.md`

## Impact
- CLI: `set-phase.mjs`, `plan-facts.mjs`, `session-status.mjs`, `session-reminder.mjs`,
  `refute.mjs`, `review-census.mjs`, `checkpoint.mjs`, `metrics/collect.mjs`,
  `metrics/dispatches.mjs`, new `review-check.mjs` and `group-close.mjs`, `bin/forge.mjs`.
- Hooks: no behavior change.
- Skill prose: `phases/implement.md`, `phases/review.md`, `subagents/*-prompt.md`.
- Output-format change: callers that parse `forge phase` / `forge status` stdout must pass
  `--json`; the repo's own hooks and scripts are updated in this change.
- Brisk pace is out of scope; tracked as a finding until escape rate by pace exists.
