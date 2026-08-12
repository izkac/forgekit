# Tasks

## 1. Counted reward contract

- [x] 1.1 Add counted-metric validation to `evals/harbor/normalize-results.mjs`:
      accept `requirements_met`/`requirements_total` and
      `regression_met`/`regression_total` as non-negative integers with
      `met <= total`. Verify: new cases in
      `evals/harbor/normalize-results.test.mjs` cover a valid counted reward and
      rejection of negative, non-integer, and `met > total`.
- [x] 1.2 Keep single-shot rewards readable: a reward without counts normalizes
      successfully with counts recorded as absent, never zero. Verify: test
      asserts an existing hard-v2-shaped reward still normalizes and that absent
      counts are `null`/missing in the output.
- [x] 1.3 Add `false_completion` as a required numeric metric for campaign
      rewards and an optional one elsewhere. Verify: tests cover 0, 1, missing
      on a campaign reward (rejected), and missing on a single-shot reward
      (accepted).
- [x] 1.4 Bump the normalized-result `schema_version` and record the reward
      shape it came from. Verify: existing normalized-result tests updated;
      `npm run test:evals` passes.

## 2. Campaign manifest and selection

- [x] 2.1 Extend `evals/harbor/corpus-selection.mjs` to parse an `episodes`
      array (episode id, index, task path) alongside the existing task list.
      Verify: `corpus-selection.test.mjs` accepts a well-formed six-episode
      manifest.
- [x] 2.2 Reject malformed campaigns: duplicate episode ids, non-contiguous or
      non-one-based indices, missing episode directories. Verify: one test case
      per rejection naming the offending episode; nothing is staged.
- [x] 2.3 Add `evals/harbor/corpora/forgekit-campaign-v1.json` declaring the
      corpus id, schema version and six episode entries with versions. Verify:
      selection test loads the checked-in manifest and resolves all six paths.
- [x] 2.4 Confirm `corpus-v1.lock.json` still passes byte-for-byte and hard-v2
      selection is unchanged. Verify: `corpus-v1-lock.test.mjs` and
      `corpus-selection.test.mjs` pass unmodified.

## 3. Episode sequencing in the runner

- [ ] 3.1 Add campaign planning to `evals/harbor/run.mjs`: one trial per
      episode per arm per repetition, recording episode id and index in
      `plan.json` and each trial manifest. Verify: `run.test.mjs` dry-run of a
      six-episode campaign with `--arm both --repetitions 1` plans twelve
      trials in the right order.
- [ ] 3.2 Execute episodes in declared order per arm, never starting episode
      N+1 before episode N reaches a terminal state. Verify: test asserts
      recorded execution order and that within-arm episodes never overlap.
- [ ] 3.3 On an episode's operational failure, record the remaining episodes of
      that arm as not attempted, continue the other arm, and exit nonzero.
      Verify: test with an injected episode-3 failure asserts episodes 4–6 are
      `not-attempted` and the other arm completed.
- [ ] 3.4 Apply the existing seeded first-arm schedule at campaign level and
      record it. Verify: test asserts the same hash-derived ordering rule and
      alternation across repetitions as the single-task path.

## 4. State carryover

- [ ] 4.1 Stage episode N+1's agent environment from episode N's `/app` output
      for the same arm and repetition. Verify: `run.test.mjs` dry-run asserts
      episode 2's staged environment contains a file written into episode 1's
      output.
- [ ] 4.2 Exclude verifier directories from carryover and assert no verifier
      source reaches any agent environment at any episode. Verify: staging test
      asserts absence across all six episodes.
- [ ] 4.3 Keep arms isolated: each arm's episode N+1 derives only from its own
      episode N. Verify: test asserts a file written only by the baseline arm
      never appears in the Forge arm's staged environment.
- [ ] 4.4 Add a carryover precondition to the shared verifier helper: a missing
      inherited marker reports an operational failure and emits no reward.
      Verify: test asserts no `reward.json` is written and the aggregator lists
      the pair as incomplete rather than crediting a zero.

## 5. Per-episode aggregation

- [ ] 5.1 Extend `evals/harbor/aggregate-results.mjs` to group campaign results
      by episode index and emit per-episode arm outcomes. Verify:
      `aggregate-results.test.mjs` on fixture runs produces six per-episode
      entries.
- [ ] 5.2 Emit the paired delta per episode index with complete and incomplete
      pair counts. Verify: test asserts deltas and counts for a fixture with one
      deliberately incomplete pair.
- [ ] 5.3 Fail closed on mixed campaign or episode revisions across run
      directories. Verify: test asserts an aggregation error rather than a
      pairing.
- [ ] 5.4 Keep existing single-task aggregation output unchanged. Verify:
      existing aggregator tests pass unmodified.

## 6. Campaign service and episodes 1–3

- [ ] 6.1 Build the episode 1 agent environment under
      `evals/harbor/tasks/forgekit-campaign-v1/episode-01/environment/`: order
      creation, charging, and the pending → paid → shipped → delivered plus
      cancelled state machine, with visible tests. Verify: visible tests run
      green in the environment image.
- [ ] 6.2 Write episode 1's instruction and separate verifier with counted
      requirement checks driven only over HTTP. Verify: oracle fixture passes,
      untouched fixture fails, and a structurally different correct fixture also
      passes.
- [ ] 6.3 Add episode 2 (partial refunds against the episode 1 ledger) with its
      verifier, re-running episode 1's checks as regression. Verify: oracle
      passes; a fixture that breaks an episode 1 invariant lowers the regression
      count while leaving the requirement count intact.
- [ ] 6.4 Add episode 3, the contradiction trap, scoring the requirement met
      only on a `BLOCKED.md` naming both requirements with earlier behaviour
      unchanged. Verify: three fixtures — reported conflict scores met, silent
      resolution scores unmet with an episode 1 regression, and an untouched
      repo scores unmet.

## 7. Episodes 4–6

- [ ] 7.1 Add episode 4 (idempotency keys on every mutating endpoint) with
      regression over episodes 1–3. Verify: oracle passes; a fixture that makes
      one endpoint non-idempotent lowers only the requirement count.
- [ ] 7.2 Add episode 5, the behaviour-preserving refactor, whose checks are
      entirely regression over episodes 1–4 plus a structural requirement.
      Verify: a correct restructuring passes all regression checks; a
      restructuring that drops an edge case fails them.
- [ ] 7.3 Add episode 6, the expiry trap, whose own checks catch expiry applied
      to terminal states. Verify: the naive fixture fails the requirement check;
      the correct fixture passes.
- [ ] 7.4 Add per-episode `false_completion` derivation to the shared verifier
      helper and cover it across the six episodes. Verify: tests assert 1 for a
      silent shortfall and 0 both for a reported blocker and for a complete
      episode.

## 8. Smoke, wiring, and docs

- [ ] 8.1 Add `evals/harbor/smoke-campaign.mjs` validating, per episode,
      manifest metadata, baseline and Forge staging, verifier isolation, and the
      host matrix (untouched negative, oracle positive, alternate positive,
      tamper negative). Verify: `node evals/harbor/smoke-campaign.mjs` passes
      without Docker and reports Docker checks as skipped.
- [ ] 8.2 Add the `smoke:evals:campaign` script to `package.json` and include
      the campaign in `npm run lint:evals`. Verify: both scripts run clean.
- [ ] 8.3 Document the corpus in `evals/README.md`: episode table, counted
      metrics, carryover rules, blocker-file contract, cost and time estimate,
      and the statement that building it produces no effectiveness evidence.
      Verify: README states the corpus is incomplete until a preregistered
      cohort runs.
## 9. Product loop

- [ ] 9.1 Add `scripts/e2e/assert-campaign-plan.mjs`: reads the newest dry-run
      plan for the given seed and asserts twelve trials, contiguous episode
      indices per arm, recorded seeded first-arm order, and no verifier source
      in any staged agent environment. Verify: exits nonzero against a plan with
      a missing episode.
- [ ] 9.2 Add `scripts/e2e/assert-campaign-carryover.mjs`: asserts every episode
      after the first was staged from the previous episode's output for the same
      arm, and that the two arms share no carried file. Verify: exits nonzero
      when carryover staging is bypassed.
- [ ] 9.3 Add `scripts/e2e/assert-campaign-aggregate.mjs` plus fixtures under
      `evals/harbor/fixtures/campaign-aggregate/`: asserts per-episode paired
      deltas, complete/incomplete pair counts, and that a carryover failure is
      reported incomplete rather than as a zero. Verify: exits nonzero when a
      fixture pair is silently credited.
- [ ] 9.4 Product-loop acceptance: run the campaign steps end to end. Verify:
      green `forge e2e run`.
