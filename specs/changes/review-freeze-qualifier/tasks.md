# Tasks

## 1. Record whether the deciding unit was on record

- [x] 1.1 Red: in `packages/cli/src/review-verdict.test.mjs`, assert
      `frozenReviewVerdict` returns `unitOnRecord` when the session carries it as
      a boolean, rejects the whole verdict when it is a non-boolean (`'yes'`,
      `0`, `null`), and — the compatibility case — still returns a valid verdict
      when the field is absent, with `unitOnRecord` reading `undefined` rather
      than `false`. Verify: fails today.
- [x] 1.2 Green: `packages/cli/src/review-verdict.mjs` accepts the optional
      field. Absent stays valid; present-and-not-a-boolean rejects the verdict
      like every other field. Widen the `@returns` shape and say in the header
      why absent is not `false`. The legal-value tripwire and the "extra keys are
      dropped" test both need updating — `unitOnRecord` is now a kept key.
      Verify: `node --test packages/cli/src/review-verdict.test.mjs`.
- [x] 1.3 Green: `packages/cli/src/set-phase.mjs` writes `unitOnRecord:
      sawTheUnit` on the verdict it freezes. `sawTheUnit` already exists and is
      already computed above the keep rule — move it, do not recompute it, so
      the persisted fact and the tested fact cannot drift. Verify:
      `node --test packages/cli/src/set-phase.test.mjs`.

## 2. Read the recorded fact instead of inferring it

- [x] 2.1 **The discriminator, first.** In `packages/cli/src/set-phase.test.mjs`,
      assert that a frozen `independent`/`inferred` verdict whose unit was
      **never** on record is still replaced by a later `self`/`host` reading, and
      the gate still refuses. This is the test that separates this change from
      "protect every frozen independent" — without it that weaker rule passes the
      suite and ships looking like this one. Write it before 2.3. Verify: passes
      today, and must still pass after 2.3.
- [x] 2.2 Red: the reproduction, in the same file. A high-risk change, prose
      reading independent, one unstopped `final` dispatch below the request
      floor; `finish` freezes `independent`/`inferred` with the unit on record;
      empty the sidecar directory; `done` must succeed and keep the verdict.
      Verify: fails today with the gate refusing — this is F49/F52.
- [x] 2.3 Green: in `set-phase.mjs`, the keep rule reads
      `frozen.unitOnRecord ?? frozen.evidence === 'host'`. Rewrite the comment
      block above it: it already names the right axis and now the code matches,
      so say what the field is, why it is persisted rather than inferred, and
      why absent takes the old test. Verify: `node --test
      packages/cli/src/set-phase.test.mjs`.
- [x] 2.4 Both reverted rules stay pinned, fixtures untouched: `a frozen verdict
      inferred from prose is never protected` and the `next.evidence` variant
      must pass without their fixtures being altered. If either needs its fixture
      changed, stop — that is the signal this fix has the same defect they were
      written to catch. Verify: same command, and say in the report which tests
      you checked and that their fixtures are byte-identical.
- [x] 2.5 Fixture sweep. Every `deepEqual` against a three-field `reviewVerdict`
      in `set-phase.test.mjs`, `ledger.test.mjs`, `score.test.mjs` and
      `review-verdict.test.mjs` goes red. Give each the value its own scenario
      would actually produce, and confirm each still fails when the rule it pins
      is broken. A fixture adjusted until the suite passes is a fixture that
      stopped testing. Verify: `npm test` green with no assertion weakened.

- [x] 2.6 Product-loop acceptance. Add a `review-evidence-pruned-record` phase to
      `scripts/e2e/harness-portability.mjs`, beside `review-evidence-survives`
      (which prunes the *transcript*; this one empties the `subagents/`
      directory, which is the shape that manufactures `seen === 0`). Drive the
      real binary: a below-floor unstopped `final` dispatch, prose reading
      independent, `finish`, empty the sidecar dir, `done`. Assert the
      transition **succeeds** and the verdict is the frozen one, not a fresh
      reading. Prints `PRUNED verdict=independent/inferred gate=passed kept=yes`.
      Register it in the change's `e2e.json`. It must fail against a build
      without the keep-rule change — confirm that and report what you saw.
      Verify: `forge e2e run --session <id>` green.

## 3. The shipped record

- [x] 3.1 Fold the delta into `specs/specs/review-evidence/spec.md`. The
      pre-existing requirement `The verdict outlives its evidence` says verdicts
      "SHALL NOT be recomputed from evidence that may since have been pruned" —
      which this chain violated for `inferred` verdicts and now satisfies. Update
      it rather than leaving the new requirement to contradict it, and drop the
      scoping note 0.3.34 added to `A dispatch must carry substance` if this
      change makes it untrue. Verify: read both requirements together and say
      whether they now agree.
- [x] 3.2 Resolve F49 and F52. Add the 0.3.35 CHANGELOG entry and bump both
      manifests. The entry must correct 0.3.34's operator guidance in
      `docs/usage.md` and its CHANGELOG entry, both of which tell the reader to
      waive a refusal that no longer happens. Verify: `grep` finds no surviving
      instruction to waive this case, and `forge finding list` shows both
      resolved.
