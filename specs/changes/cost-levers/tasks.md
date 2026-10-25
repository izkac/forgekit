# Tasks

## 1. Dispatch budget
- [x] 1.1 Projection: `projectDispatches(facts, pace)` in `packages/cli/src/plan-facts.mjs` (work units ≤4 tasks, 1:1 high-risk, group reviewers per `review.perTask`, final review); unit tests in `plan-facts.test.mjs` for over/within budget and direct plan
- [x] 1.2 Budget warning on `forge phase implement` in `set-phase.mjs`, reading `budget.subagents` (default 15); test in `set-phase.test.mjs` that the warning prints and the transition still succeeds
- [x] 1.3 `dispatches n/<budget>` in `session-status.mjs` and `session-reminder.mjs`, counting `decision: "allow"` lines of the existing `<session>/dispatches.jsonl` (reuse `metrics/dispatches.mjs` reader), `?` for an unreadable log, one warning line over budget; digest field `dispatchBudget` in `ledger.mjs`; tests

## 2. Review claims
- [x] 2.1 `packages/cli/src/review-check.mjs` parser: blocking items, three evidence forms, downgrade to Minor, effective verdict; `review-check.test.mjs` covering every scenario in the delta
- [x] 2.2 `forge review-check <file>` command in `bin/forge.mjs` with `--json`; CLI test
- [x] 2.3 `review-census.mjs` counts a rejection only with ≥1 backed blocking item; tests that floors still require the dispatch
- [x] 2.4 `forge refute list --md --for-diff <range>` in `refute.mjs`: session entries + ≤20 basename matches from `.forge/known-false.jsonl`, most recent first; tests for match and cap

## 3. Coordinator context
- [ ] 3.1 `metrics/collect.mjs` + `metrics/dispatches.mjs`: carry the existing `breakdown.parent` / `breakdown.subagents` split into the `sessions.jsonl` digest, add a per-group split and mean context per coordinator request, `null` when not separable; the running dispatch count also counts `decision: "rewrite"` lines (they run); tests with `test-host-tree.mjs` fixtures
- [ ] 3.2 `packages/cli/src/group-close.mjs` + `forge group close --group <name>`: checkpoint (when enabled) → range → precheck → label, one short block, stop on failing step; tests
- [ ] 3.3 `--brief` short output for `forge phase` and `forge status` (default JSON unchanged); tests

## 4. Prompts, docs and product loop
- [ ] 4.1 `skills/forge/subagents/task-reviewer-prompt.md`, `final-reviewer-prompt.md`, `closer-prompt.md`: Evidence line rules and `{KNOWN_FALSE}`; implementer and reviewer prompts end with the short-reply rule (docs-only, `--no-tdd`)
- [ ] 4.2 `phases/implement.md` / `phases/review.md` / `references/pace.md`: `forge group close`, `forge review-check` (only backed items start a fix round), budget warning, `refute list --for-diff` in reviewer briefs; `docs/forge.md` and CHANGELOG note the output change (docs-only, `--no-tdd`)
- [ ] 4.3 Product loop: extend `scripts/e2e/harness-portability.mjs` with steps that trip the budget warning on a scratch plan and run `forge group close` end to end; record in the session `e2e.json` and get a green `forge e2e run`
