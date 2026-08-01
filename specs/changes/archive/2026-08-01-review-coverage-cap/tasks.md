# Tasks

## 1. The zero-review fixture, red first

- [x] 1.1 Write the zero-review test FIRST in `packages/cli/src/score.test.mjs`
      (F13 mandates this case before any other): a `thorough` session, 6+ tasks,
      strong artifacts (valid spine with rows, green product-loop evidence, all
      tasks complete, no deferrals), and **no review files at all**. Assert
      `card.score <= 69`. Verify it fails red against today's scorer with the
      actual uncapped score printed in the failure message.
      Verify: `node --test packages/cli/src/score.test.mjs` — this test red, all
      others green.

- [x] 1.2 Add the 0.3.25 inversion as an explicit monotonicity regression: build
      the zero-review fixture and an otherwise-identical fixture carrying one
      independent per-group review across six groups, and assert
      `zeroReview.score <= oneReview.score`. This is the exact pair 0.3.25 got
      backwards (95/A vs 69/C). Verify: red for the same reason as 1.1.

## 2. The cap function

- [x] 2.1 Add pure `reviewCoverageCap({ census, resolvedPace, tasks })` to
      `packages/cli/src/score.mjs` returning `{ cap, reason } | null`. Tiers per
      design D1: `independent === 0 && finalReview !== 'independent'` → 69;
      `independent === 0 && finalReview === 'independent'` → 89; otherwise null.
      Guards per D2/D3: only `resolvedPace` in `{thorough, standard}`, only
      `tasks >= 5`. No filesystem access, no group denominator.
      Verify: direct unit tests for all six branches, no session dir built.

- [x] 2.2 Wire it at the call site after the existing health/high-risk caps,
      reading the SAME merged `census` object (live + frozen verdict) the
      high-risk cap reads — per D4, never a fresh `reviewCensus` call. Take the
      task count from `planFacts.tasks` when readable, else `session.tasksTotal`.
      Push to `caps` only when it actually lowers the score.
      Verify: tests 1.1 and 1.2 go green; full `node --test packages/cli/src/score.test.mjs` green.

## 3. The exemptions and the lift

- [x] 3.1 Test the lift: the zero-review fixture plus one independent per-group
      review scores above 89 and carries no coverage cap.
      Verify: `node --test packages/cli/src/score.test.mjs`.

- [x] 3.2 Test both pace exemptions (`brisk`, `lite` with zero reviews → no cap)
      and the task floor (`standard`, 3 tasks, zero reviews → no cap). These are
      the "punish obedience" cases 0.3.24 shipped and 0.3.26 reverted.
      Verify: `node --test packages/cli/src/score.test.mjs`.

- [x] 3.3 Test the 89 tier and its cap text: zero per-group reviews with an
      independent final review caps at 89, and the reason is distinguishable
      from the 69 case. Include a frozen-verdict case per D4 — prose reading
      `self`, frozen verdict `independent` — asserting the cap follows the
      frozen verdict.
      Verify: `node --test packages/cli/src/score.test.mjs`.

## 4. Product-loop acceptance

- [x] 4.1 Write `scripts/e2e/review-coverage-cap.mjs` — drives the **shipped
      `forge` binary** against throwaway session dirs in a temp dir (same shape
      as `scripts/e2e/thorough-re-narrowing.mjs`), building six real sessions:
      zero-review, final-review-only, one-reviewed, brisk, sub-5-task, and the
      monotonicity pair. Asserts each `forge score` outcome and prints exactly
      `COVERAGE-CAP zero=capped69 finalOnly=capped89 reviewed=uncapped
      brisk=uncapped small=uncapped monotone=ok`. Steps that would pass against
      a stubbed scorer are invalid — it must invoke the real CLI.
      Verify: `forge e2e run` green (this is the product-loop gate).

## 5. Corpus check and docs

- [x] 5.1 Re-run the corpus simulation against the shipped code (not a
      hand-written model of it) over the 18 rows of `.forge/sessions.jsonl`, and
      record the before/after grade table in `verify-evidence.md`. Expected:
      exactly three sessions move A→B (94→89, 97→89, 90→89), twelve unchanged,
      three already below their cap. Any deviation from the design's predicted
      table is a defect in the cap, not in the prediction.
      Verify: simulation output pasted into `verify-evidence.md`.

- [x] 5.2 Add the `CHANGELOG.md` entry under Unreleased, stating what the
      0.3.25 attempt got backwards and how this one cannot repeat it (census
      field always assigned vs. a variable one path skips), plus the measured
      three-session effect. Verify: entry present, names F13.

- [x] 5.3 Resolve F13 in the findings ledger with the change slug, and re-check
      its dependents per the findings guardrail: confirm F16 is still accurate
      (the cap does not use the denominator) and F14 is unchanged in kind.
      Verify: `forge finding list --status open` no longer shows F13.

## 6. Final-review fixes (added after the independent final review)

- [x] 6.1 Gate the cap on the effective `review.perTask` knob rather than
      `resolvedPace`. The final reviewer reproduced an over-fire: with
      `review.perTask=never` at `standard` pace, `shouldRunPerTaskReview` returns
      false yet the session was capped, claiming reviewers were prescribed —
      the "punish obedience" class this subsystem was reverted for twice.
      Resolution happens at the call site so `reviewCoverageCap` stays pure, and
      unresolvable preferences do not cap.
      Verify: reviewer's repro red before, green after; `npm test`; `forge e2e run`.

- [x] 6.2 Pin the invariant that a cap must never RAISE a score. Deleting
      `&& score > coverageCap.cap` left all 872 tests and the e2e green while
      promoting a 59/D incomplete session to 89/B. The guard was correct; nothing
      tested it. Verify: new tests red with the guard removed, green with it.
