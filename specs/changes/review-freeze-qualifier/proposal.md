# A pruned dispatch record stops refusing a review that really happened

## Why

`freezeReviewVerdict` in `packages/cli/src/set-phase.mjs` protects an
already-frozen verdict from being overwritten by a second pass that learnt
nothing — but only when the frozen verdict was graded `host`:

```js
const measured = frozen?.final === 'independent' && frozen?.evidence === 'host';
```

The comment above that line names the right axis — *"whether this pass saw the
unit that decides, not how much it saw"* — and the code asks a different
question. A verdict graded `inferred` gets no protection at all.

Since 0.3.34 that is a large and growing population: the request floor routes
every sub-floor dispatch to prose, so verdicts that used to freeze
`independent`/`host` now freeze `independent`/`inferred`.

The consequence, reproduced by 0.3.34's own final reviewer: a high-risk change
with a review file reading independent and one genuine unstopped `final` dispatch
of four requests freezes `independent`/`inferred` at `finish`; empty the sidecar
directory and `done` finds `seen === 0`, which grades `self`/`host` ("nothing was
dispatched"), the frozen verdict is unprotected, the negative overwrites, and the
money/auth gate **refuses**. 0.3.33 passed the same session.

It is permanent. `saveSession` runs after the gate's `process.exit(1)`, so the
refused pass records nothing and every retry repeats it. `--final-review-waived`
is the only way through, filing a durable waiver against a session that *was*
independently reviewed. This is finding **F49**, extended with measurements as
**F52**.

## What Changes

- `session.json` → `reviewVerdict` gains **`unitOnRecord`**: whether the pass
  that froze the verdict saw the deciding (`final`) unit in the host's record.
  It is `sawTheUnit`, persisted.
- The keep rule reads it instead of inferring from the evidence grade:
  `frozen.final === 'independent' && (frozen.unitOnRecord ?? frozen.evidence === 'host')`.
- `frozenReviewVerdict` accepts the field as **optional and boolean-if-present**,
  so verdicts frozen before this change stay valid and keep today's behaviour
  through the `??` arm.

No change to `hostFinalReview`, the census, the request floor, the `remeasured`
or `sawTheUnit` conjuncts, or the gate's own `final === 'independent'` test.

## Capabilities

- `review-evidence`: a verdict is replaced only by a pass that learnt something
  about the thing being judged — delta at `specs/review-evidence/spec.md`

## Impact

**Affected code**

- `packages/cli/src/set-phase.mjs` — write `unitOnRecord`; read it in the keep rule
- `packages/cli/src/review-verdict.mjs` — accept the optional field
- `packages/cli/src/set-phase.test.mjs`, `review-verdict.test.mjs`,
  `ledger.test.mjs`, `score.test.mjs` — the reproduction, the discriminator, the
  compatibility cases, and a fixture sweep

**Risk: the fix becomes "protect every frozen independent".** That is the
option this design rejected, and the thing that distinguishes them is a single
test — a frozen `independent`/`inferred` whose unit was *never* on record must
still refresh and still refuse. Without it the two implementations are
indistinguishable and the weaker one ships. It is the first task in group 2.

**Risk: two prior rules on this exact axis were reverted.** `set-phase.test.mjs`
pins both — `a frozen verdict inferred from prose is never protected` (dropping
the evidence conjunct) and the `next.evidence` variant. Both must stay green
without their fixtures being altered. Test 669's fixture has no host evidence in
either pass, so `unitOnRecord` is `false` on both and it is unaffected by
construction; that is a prediction to verify, not an assumption to build on.

**Risk: a required field would strand every existing session.**
`frozenReviewVerdict` is deliberately strict, so a mandatory `unitOnRecord` would
make every verdict frozen before this change read `null` and fall back to a live
census — discarding exactly the measurements the freeze exists to preserve.
Optional-and-boolean-if-present is the whole mitigation, and "absent" must mean
"written before the field existed", never "false".

**Migration**: none. Old sessions take the `??` arm and behave exactly as today.
