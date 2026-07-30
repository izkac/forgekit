# Tasks

## 1. Measure the busiest unstopped dispatch

- [x] 1.1 Red: in `packages/cli/src/metrics/review-evidence.test.mjs`, assert a
      unit with a stopped 60-request dispatch and a completed 20-request
      dispatch reports `requests: 80` and `maxRequests: 20`. Verify: the new
      case fails against today's `reviewEvidence`.
- [x] 1.2 Green: add `maxRequests` to the bucket in
      `packages/cli/src/metrics/review-evidence.mjs` (`reviewEvidence`, the
      `units[record.unit] ??=` block ~line 602) — the maximum `record.requests`
      across records where `stoppedByUser` is false, `0` when every dispatch was
      stopped. Update the `@returns` shape and the module header. Do **not**
      introduce the floor here: this module measures, it does not judge.
      Verify: `node --test packages/cli/src/metrics/review-evidence.test.mjs`.
- [x] 1.3 Cover the edges in the same test file: every dispatch stopped →
      `maxRequests: 0`; a single unstopped dispatch → `maxRequests === requests`;
      a record whose transcript was pruned (`requests: 0`) keeps `maxRequests: 0`
      rather than being dropped. Verify: same command.

## 2. A dispatch below the floor stops certifying the review

- [x] 2.1 Red: in `packages/cli/src/review-census.test.mjs`, assert a session
      whose only final-review dispatch made 1 request, beside a review file whose
      prose admits no subagent ran, censuses as `finalReview: 'self'` with
      `finalReviewEvidence: 'inferred'`. Verify: fails today with `host` /
      `independent` — this is F33's reproduction.
- [x] 2.2 Green: in `packages/cli/src/review-census.mjs`, add
      `FINAL_REVIEW_REQUEST_FLOOR = 5` beside the other census constants and
      apply it in `hostFinalReview` (~line 277) on the branch that would return
      `independent`: a `maxRequests` below the floor returns `null`. Document
      the corpus (24 dispatches, min 15 / median 55 / max 173, 2026-07-30) and
      the rule that it is re-measured before it moves. Verify:
      `node --test packages/cli/src/review-census.test.mjs`.
- [x] 2.3 Guard the shape, in the same file: a bucket whose `maxRequests` is
      absent or not a number returns `null` (prose), never zero — the same
      "present and unreadable is not absent" rule the existing `dispatched` /
      `stopped` guard states. This is the path persisted evidence written before
      this change takes. Verify: same command, with a JSON round-trip fixture.
      **Includes a fixture sweep of this file.** Seven existing fixtures reach
      the floor line with `maxRequests` absent (lines 332, 372, 396, 549, 573,
      604, 620) and pass only because `undefined < 5` is false — they assert
      `independent` for a shape `reviewEvidence` never emits, and the guard turns
      all seven red. Give each a `maxRequests` its own dispatches would actually
      produce, and apply 2.6's discipline: confirm each still fails when the
      floor is removed. Line 620 (`dispatched: 2, stopped: 1, requests: 61`) is
      the one to watch — it is the stopped-beside-completed pair, where the value
      chosen decides whether the test still means anything.
- [x] 2.4 The two evasions, as their own cases — **both shapes are required**,
      because until they land nothing pins the production code's choice of
      `maxRequests` over `requests` (with one dispatch the two are identically
      equal, so the substitution survives every test written so far): ten
      1-request dispatches for one unit → no host answer (the sum must not be
      what is tested); a stopped 60-request dispatch beside a completed
      1-request one → no host answer (the stopped dispatch must not vouch for the
      live one — the case the census comment argues for and the one currently
      unproven). Each must be shown to fail against a `bucket.requests`
      substitution. Verify: same command.
- [x] 2.5 A reviewer that genuinely ran is untouched: 55 requests beside a review
      file whose prose reads like a self-check still censuses `independent` on
      `host`. Verify: same command, plus
      `node --test packages/cli/src/set-phase.test.mjs` — the money/auth gate
      still passes this session.
- [x] 2.6 Repair the fixtures the floor invalidated.
      `writeReviewerSidecars` in `packages/cli/src/set-phase.test.mjs` (~line
      195) writes one transcript line per agent, so every dispatch it plants now
      reads as a token dispatch and 8 of 41 tests fail — 3 of them because the
      gate refuses. Give each unstopped sidecar at least
      `FINAL_REVIEW_REQUEST_FLOOR` distinct request ids. Added during implement:
      the breakage is a consequence of 2.2 that the plan implied at 2.5's verify
      step but never named. Verify: `node --test
      packages/cli/src/set-phase.test.mjs` back to its pre-change count, and
      confirm each repaired test still fails when the floor is removed —
      a fixture bumped until it passes is a fixture that stopped testing.

## 3. Test the validator in front of the gate (F34)

- [x] 3.1 Add `packages/cli/src/review-verdict.test.mjs` covering
      `frozenReviewVerdict` directly: a non-object session, an absent
      `reviewVerdict`, an array, `final: null` (valid — "there is no final
      review"), an unrecognised `final`, an unrecognised `evidence`, a
      non-boolean `stoppedByOperator`, and the valid round-trip returning
      exactly `{final, evidence, stoppedByOperator}`. Verify:
      `node --test packages/cli/src/review-verdict.test.mjs`.
- [x] 3.2 Assert it never throws on hostile input (frozen object, prototype-less
      object, `reviewVerdict` as a string, getters that throw) — every caller is
      on the `forge phase done` path and a throw there loses the transition.
      Verify: same command. `review-verdict.mjs` itself must not change; if a
      test forces a change, stop and record why.
- [x] 3.3 Make the "never throws" contract true. 3.2 found it false: a getter or
      Proxy trap that raises propagates out of `frozenReviewVerdict`, because the
      function has no `try`. Wrap the body and return `null` on a throw — the
      value every caller already reads as "fall back to a live census", and the
      only answer that cannot refuse correct work. Un-`todo` 3.2's test. Added
      during implement on the operator's decision: the plan said the module would
      not change, and it does, because shipping a validator in front of the
      money/auth gate whose header claims a guarantee it does not provide is the
      same defect class this change exists to correct. Verify: `node --test
      packages/cli/src/review-verdict.test.mjs` with no todo remaining, and
      `node --test packages/cli/src/set-phase.test.mjs` still 41/41.

## 4. Product-loop acceptance and the shipped record

- [x] 4.1 Add a `review-evidence-substance` phase to
      `scripts/e2e/harness-portability.mjs`, beside `review-evidence-decides`:
      plant a sidecar whose final-review dispatch carries a single request,
      write the self-check review file, and require `forge phase done` to
      **refuse** on the money/auth floor. Prints
      `REVIEW final=self evidence=inferred gate=refused`. Verify: run the phase
      directly.
- [x] 4.2 Register the step in the change's `e2e.json` with that expected line
      and run `forge e2e run --session <id>` green. Verify: the run is green and
      recorded against the current `e2e.json`.
- [x] 4.3 Sync the shipped record: fold the delta into
      `specs/specs/review-evidence/spec.md`; correct the claim in `docs/usage.md`
      (the task originally named `docs/forge.md`, which never carried it) and the
      0.3.29 CHANGELOG entry that the dispatch record cannot be
      fabricated (it can — dispatching a subagent is cheap; what is now costly is
      dispatching one that does nothing); add the 0.3.34 entry. Verify:
      `grep` finds no surviving "cannot be fabricated" claim.
- [x] 4.4 Resolve F33 and F34 with notes naming the floor and the corpus, and
      file a finding recording that the prose rules (F11/F18/F19) now carry more
      traffic than they did. Verify: `forge finding list` shows both resolved.
