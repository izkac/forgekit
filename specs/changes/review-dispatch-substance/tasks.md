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

- [ ] 2.1 Red: in `packages/cli/src/review-census.test.mjs`, assert a session
      whose only final-review dispatch made 1 request, beside a review file whose
      prose admits no subagent ran, censuses as `finalReview: 'self'` with
      `finalReviewEvidence: 'inferred'`. Verify: fails today with `host` /
      `independent` — this is F33's reproduction.
- [ ] 2.2 Green: in `packages/cli/src/review-census.mjs`, add
      `FINAL_REVIEW_REQUEST_FLOOR = 5` beside the other census constants and
      apply it in `hostFinalReview` (~line 277) on the branch that would return
      `independent`: a `maxRequests` below the floor returns `null`. Document
      the corpus (24 dispatches, min 15 / median 55 / max 173, 2026-07-30) and
      the rule that it is re-measured before it moves. Verify:
      `node --test packages/cli/src/review-census.test.mjs`.
- [ ] 2.3 Guard the shape, in the same file: a bucket whose `maxRequests` is
      absent or not a number returns `null` (prose), never zero — the same
      "present and unreadable is not absent" rule the existing `dispatched` /
      `stopped` guard states. This is the path persisted evidence written before
      this change takes. Verify: same command, with a JSON round-trip fixture.
- [ ] 2.4 The two evasions, as their own cases: ten 1-request dispatches for one
      unit → no host answer (the sum must not be what is tested); a stopped
      60-request dispatch beside a completed 1-request one → no host answer (the
      stopped dispatch must not vouch for the live one). Verify: same command.
- [ ] 2.5 A reviewer that genuinely ran is untouched: 55 requests beside a review
      file whose prose reads like a self-check still censuses `independent` on
      `host`. Verify: same command, plus
      `node --test packages/cli/src/set-phase.test.mjs` — the money/auth gate
      still passes this session.

## 3. Test the validator in front of the gate (F34)

- [ ] 3.1 Add `packages/cli/src/review-verdict.test.mjs` covering
      `frozenReviewVerdict` directly: a non-object session, an absent
      `reviewVerdict`, an array, `final: null` (valid — "there is no final
      review"), an unrecognised `final`, an unrecognised `evidence`, a
      non-boolean `stoppedByOperator`, and the valid round-trip returning
      exactly `{final, evidence, stoppedByOperator}`. Verify:
      `node --test packages/cli/src/review-verdict.test.mjs`.
- [ ] 3.2 Assert it never throws on hostile input (frozen object, prototype-less
      object, `reviewVerdict` as a string, getters that throw) — every caller is
      on the `forge phase done` path and a throw there loses the transition.
      Verify: same command. `review-verdict.mjs` itself must not change; if a
      test forces a change, stop and record why.

## 4. Product-loop acceptance and the shipped record

- [ ] 4.1 Add a `review-evidence-substance` phase to
      `scripts/e2e/harness-portability.mjs`, beside `review-evidence-decides`:
      plant a sidecar whose final-review dispatch carries a single request,
      write the self-check review file, and require `forge phase done` to
      **refuse** on the money/auth floor. Prints
      `REVIEW final=self evidence=inferred gate=refused`. Verify: run the phase
      directly.
- [ ] 4.2 Register the step in the change's `e2e.json` with that expected line
      and run `forge e2e run --session <id>` green. Verify: the run is green and
      recorded against the current `e2e.json`.
- [ ] 4.3 Sync the shipped record: fold the delta into
      `specs/specs/review-evidence/spec.md`; correct the claim in `docs/forge.md`
      and the 0.3.29 CHANGELOG entry that the dispatch record cannot be
      fabricated (it can — dispatching a subagent is cheap; what is now costly is
      dispatching one that does nothing); add the 0.3.34 entry. Verify:
      `grep` finds no surviving "cannot be fabricated" claim.
- [ ] 4.4 Resolve F33 and F34 with notes naming the floor and the corpus, and
      file a finding recording that the prose rules (F11/F18/F19) now carry more
      traffic than they did. Verify: `forge finding list` shows both resolved.
