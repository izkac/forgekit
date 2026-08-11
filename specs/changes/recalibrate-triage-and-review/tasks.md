# Tasks

## 1. Make the skip gate satisfiable

- [x] 1.1 Record the pre-change yield baseline at
      `specs/changes/recalibrate-triage-and-review/baseline-yield.md`: per-pace
      sessions, tasks, independent reviews, reviews/task, rejections and
      rejections per 100 tasks, naming the source ledgers and the measurement
      date. Verify: figures reproduce from the checked-in ledgers.
- [x] 1.2 Correct `skills/forge/references/substantial-work.md`: skip conditions
      become **ANY**, and the closing line re-requiring explicit opt-out is
      removed. Verify: the file no longer states both that a negative answer
      means direct execution and that skipping needs opt-out.
- [x] 1.3 Widen `isTrivialEdit` in `packages/cli/src/triage-prompt.mjs` to match
      the corrected doc (formatting, comment-only, rename with no behaviour
      change, changelog and docs-only edits), keeping the special case for
      "fix a typo". Verify: new cases in `triage-prompt.test.mjs` for each
      trivial form.
- [x] 1.4 Keep the fail-closed posture: a prompt matching no trivial marker and
      no clear skip condition is still substantial. Verify: tests assert
      "add a new payment endpoint" is substantial and an unrecognized prompt is
      substantial.

## 1b. Hand the decision to the agent

Added mid-implement on user direction: the prompt filter must stop deciding
substantiality and only suppress. See the `pace-signals` requirement *The agent
decides substantiality, not the prompt filter*.

- [x] 1.5 Reframe `skills/forge/references/substantial-work.md` as judgment
      criteria the agent weighs with full context, stating plainly that the
      agent decides and the prompt-time filter only suppresses. Verify: the doc
      no longer reads as a specification of the regex, and says who decides.
- [x] 1.6 Change the triage reminder in `packages/cli/src/triage-prompt.mjs`
      (`buildForgeTriageMessage`) from asserting a verdict ("Substantial work
      detected") to asking the agent to decide. Verify: a test asserts the
      emitted message asks for a decision and contains no detection claim.
- [x] 1.7 Rename the classifier entry point so nothing claims the filter
      decides substantiality: the exported predicate becomes a "should the
      agent be asked" question, and the module docstring stops describing
      itself as mirroring the guidance doc. Verify: tests cover the renamed
      entry point and no consumer still imports a name asserting
      substantiality.
- [x] 1.8 Update `forge triage --check` help and `--message` output so exit 0
      means "ask the agent", not "this is substantial". Verify: a test asserts
      the help text states the suppression semantics.

## 2. Re-cut the preset matrix

- [x] 2.1 Update `packages/cli/src/preferences.defaults.json`: `thorough.review.perTask`
      becomes `per-group`. Verify: `preferences.test.mjs` asserts no preset uses
      `always`.
- [x] 2.2 Set `brisk.review.final` and `lite.review.final` to `always`, and
      `lite.review.maxRounds` to 1. Verify: test asserts every preset has a
      final review and at least one fix round.
- [x] 2.3 Assert the standard/thorough relationship in tests: identical cadence,
      differing `maxRounds`. Verify: `preferences.test.mjs` covers it.
- [x] 2.4 Confirm the high-risk hard floor is unaffected by the cadence change.
      Verify: test asserts a high-risk task requires an immediate per-task
      review under `lite`.

## 3. Two-way pace resolution

Re-cut mid-implement. The de-escalation behaviour these tasks were written to
add already ships (`suggestPaceFromPlan` + `maybeResolvePaceFromPlan`, 0.3.17) —
see design **D4**. What is missing is the record, so these tasks now cover that.

- [x] 3.1 Pin down the existing two-way behaviour with tests before changing
      anything around it: a small single-capability plan with no wired spine
      rows lowers the pace, a large plan raises it, and a high-risk plan does
      not lower. Verify: `plan-facts.test.mjs` covers all three, and each
      assertion is shown to fail when the corresponding rule is broken.
- [x] 3.2 Record the downward move symmetrically with the upward one in
      `packages/cli/src/set-phase.mjs`: `maybeEscalatePaceForTaskCount` sets
      `paceEscalated`, so a plan-driven lowering needs its own marker alongside
      the existing `paceResolvedFrom: 'plan'`, which records that the plan
      decided but not which way. Verify: `set-phase.test.mjs` asserts the marker
      and the reason for both directions.
- [x] 3.3 Record pin suppression in `packages/cli/src/set-phase.mjs`: both
      `maybeEscalatePaceForTaskCount` and `maybeResolvePaceFromPlan` currently
      return early on `pacePinned` having written nothing, so a suppressed
      adjustment is indistinguishable from no signal. Record what the pin
      overrode. Verify: test asserts the pinned pace is unchanged **and** the
      suppression, including the pace that would have been chosen, is on the
      session.
- [x] 3.4 Make `packages/cli/src/score.mjs` read the de-escalation marker so a
      legitimately lowered pace can never be scored as a missing escalation,
      independent of whether today's thresholds happen to overlap. Verify:
      `score.test.mjs` covers a de-escalated session receiving no deduction,
      and the test fails if the marker is ignored.

## 4. Plan-time exit ramp

- [x] 4.1 Add exit-condition resolution beside the existing ceremony resolver in
      `packages/cli/src/plan-facts.mjs`: few tasks, one capability, no wired
      spine rows, no high-risk surface. Verify: unit tests for qualifying and
      non-qualifying shapes, including high-risk never qualifying.
- [x] 4.2 Offer the exit in `skills/forge/phases/brainstorm.md` before change
      artefacts are scaffolded, and document that the offer is made, not taken
      silently. Verify: the phase doc states the check and its position in the
      flow.
- [x] 4.3 Record an accepted exit as the skipped phase carrying the resolved
      shape as its reason. Verify: `set-phase` test asserts the ledger row and
      the reason naming task count, capability count and spine-row absence.
- [x] 4.4 Record a declined offer on the session and proceed to plan. Verify:
      test asserts the declined offer is present and the session reaches plan.

## 5. Review-yield reporting

- [x] 5.1 Add the per-pace yield table to `packages/cli/src/analyze.mjs`:
      sessions, tasks, independent reviews, reviews/task, rejections, rejections
      per 100 tasks. Verify: `analyze` tests over a fixture ledger produce one
      row per pace present.
- [x] 5.2 Derive the figures from recorded review stamps only, never from
      harvested dispatch counts; report missing telemetry as missing. Verify:
      test with a session whose host metrics failed but which recorded reviews
      counts those reviews.
- [x] 5.3 Omit paces with no recorded sessions. Verify: test asserts no empty
      rows.
- [x] 5.4 Cover the table in `--json` output with a stable shape. Verify: test
      asserts the JSON keys.

## 6. Docs, distribution, and product loop

- [x] 6.1 Update `skills/forge/references/pace.md`: the new preset matrix, the
      two-way resolution rules, and the plan-time exit ramp. Verify: the
      documented matrix matches `preferences.defaults.json` exactly.
- [x] 6.2 Note in `docs/forge.md` that skill doc changes reach other machines
      only after `forgekit install --skills forge --force`. Verify: the
      statement is present where the install flow is described.
- [x] 6.3 Add a regression test asserting the documented matrix in `pace.md`
      matches the shipped defaults, so the two cannot drift. Verify: the test
      fails when either side is edited alone.
## 7. Product loop

- [ ] 7.1 Add `scripts/e2e/assert-triage-skip.mjs`: drives `forge triage
      --check` over a fixed set of trivial prompts and, with `--substantial`,
      over real-work prompts. Verify: exits nonzero if any trivial prompt still
      triggers Forge or any real-work prompt slips through.
- [ ] 7.2 Add `scripts/e2e/assert-pace-two-way.mjs`: drives the shipped CLI in
      the scratch project through a small plan and a large one, asserting the
      pace moves both ways and that a pinned pace does not move. Verify: exits
      nonzero if de-escalation is missing or a pin is overridden.
- [ ] 7.3 Add `scripts/e2e/assert-review-yield.mjs`: asserts the yield table is
      computed from review stamps, omits absent paces, and does not read failed
      telemetry as zero reviews. Verify: exits nonzero when a session with
      failed metrics collection is counted as zero reviews.
- [ ] 7.4 Product-loop acceptance: drive the real CLI through triage, a
      de-escalating plan, and the yield table. Verify: green `forge e2e run`.
