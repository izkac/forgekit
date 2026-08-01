# Tasks

## 1. Plan-facts group counting (F16)

- [x] 1.1 RED: `plan-facts.test.mjs` — `## Notes` and a fenced `##` do not
      inflate `groups`; numbered `## 1.` / `## 2)` do. Headingless with tasks
      still reports `groups: 0`. Verify RED.
- [x] 1.2 GREEN: implement fence strip + numbered-group `GROUP_RE` in
      `plan-facts.mjs`. Same tests green. Resolve F16.

## 2. Structured caps (F14)

- [x] 2.1 RED: `score.test.mjs` / fleet-report tests — when score is already
      ≤ OUTCOME_CAP, a high-risk note is recorded with `applied: false` and
      does not mark the session capped in fleet; an actually applied cap has
      `applied: true` and lowers the score. Verify RED.
- [x] 2.2 GREEN: structured caps in `score.mjs`; fleet-report reads
      `applied`; legacy string caps still count as applied. Resolve F14.

## 3. Product-loop e2e

- [x] 3.1 `scripts/e2e/score-coverage-denominator.mjs` + `e2e.json`: plant a
      tasks.md with one numbered group + Notes + fenced heading; score notes
      say `across 1 task group(s)`. Plant a session that only notes a cap
      (applied:false) and assert fleet capped count does not include it.
      Single status line. `forge e2e run` green.
