# Tasks

## 1. Stamp module and writer

- [x] 1.1 `packages/cli/src/review-stamp.mjs` (new) with
      `review-stamp.test.mjs` (new, test-first): `writeStamp(sessionDir,
      { unit, label, sessionId, model })` appends to
      `reviews/dispatches.json` (creates the directory, `version: 1`,
      append-only `stamps` array, ISO `at`, returns `{ ok, path }` or
      `{ ok: false, reason }` — never throws); `readStamps(sessionDir)`
      returns only structurally valid stamps (`unit`/`label`/`sessionId`/
      `at` non-empty strings), `[]` for a missing, unreadable or malformed
      file, and never throws. Tests: round-trip; append preserves earlier
      stamps; malformed file → `[]`; invalid entries dropped while valid
      neighbours survive; unwritable dir → `{ ok: false }`.
- [x] 1.2 `packages/cli/src/review-label-cli.mjs`: after the session
      resolves, resolve the model in-process via `resolveModel({ tier })`
      from `resolve-model.mjs` (default `capable`, new `--tier
      fast|standard|capable` flag) and `writeStamp` into the session's
      directory (from `loadSession().dir`). Stamp path and resolved model
      reported on **stderr**; **stdout stays byte-identical** (the label
      alone). Stamp or model-resolution failure warns on stderr, exits 0,
      still prints the label. New `review-label-cli.test.mjs` spawning the
      CLI in a temp project (pattern: `metrics-cli.test.mjs`): stamp
      written with correct unit/label/sessionId/model; stdout unchanged
      byte-for-byte; unwritable `reviews/` still prints the label and
      exits 0; `--tier standard` lands in the stamp; unknown `--tier`
      value refuses.

## 2. Census precedence: host > recorded > inferred

- [x] 2.1 `packages/cli/src/review-census.mjs`: when `hostFinalReview`
      returns `null`, consult `readStamps(sessionDir)` before prose — a
      valid `final` stamp whose `sessionId` equals
      `path.basename(sessionDir)` yields `{ finalReview: 'independent',
      finalReviewEvidence: 'recorded' }` with the prose untouched (write
      the test so it goes red if the body is evaluated, mirroring the host
      path's pins). `stoppedByOperator` stays `false` (placeholder, as
      documented). `CENSUS_RULE` → 5 with a rule-table entry. Tests in
      `review-census.test.mjs`: stamp + no evidence → recorded/independent
      even when the prose declares `self-check`; stamp + no final review
      file → `null`/`none`; no stamp → unchanged prose fallback; stamp +
      host answering `self` (all dispatches stopped) → host wins; stamp +
      host answering `independent` → `host` grade, not `recorded`.
- [x] 2.2 The D3 guard, same files: the stamp is **not** consulted when the
      evidence carries a well-formed `final` bucket (available, numeric
      tallies, bucket with numeric `dispatched`/`stopped`/`maxRequests`) —
      the below-floor branch keeps falling to prose. Tests: stamp + a
      1-request final bucket → prose decides (both a self-declaring file →
      `self`/`inferred` and a silent file → `independent`/`inferred`, both
      graded `inferred`); stamp + *malformed* final bucket → stamp answers
      (`recorded`); stamp whose `sessionId` names a different session →
      prose; malformed `dispatches.json` → prose, no throw.

## 3. Gate, freeze and consumers

- [x] 3.1 `packages/cli/src/set-phase.test.mjs`: pin the gate and freeze on
      the new grade (expect no production change in `set-phase.mjs` beyond
      comments — the floor tests `final === 'independent'` only). Tests: a
      high-risk session with a stamp, a final review file and no host
      evidence passes `forge phase done` with frozen verdict
      `{ final: 'independent', evidence: 'recorded' }`; a frozen
      `recorded` verdict refreshes to `self`/`host` when a later pass sees
      the host record of an all-stopped dispatch; a frozen `host`
      `independent` verdict is kept (not downgraded to `recorded`) on a
      second pass whose host evidence is gone but whose stamp survives.
- [x] 3.2 Consumer audit + the F58 comment contract: update the four
      comment blocks that name F12 as unbuilt owner —
      `metrics/review-evidence.mjs` (pruned-residual block),
      `set-phase.mjs` at `freezeReviewVerdict` and at the below-the-gates
      write, `set-phase.test.mjs` — plus `review-census.mjs`'s header and
      the `'recorded'` reservation in its returns doc, and
      `review-verdict.mjs:56`, whose EVIDENCE doc still calls `recorded`
      "reserved for a signed attestation, not yet produced by anything"
      (2.1's reviewer flagged it as the fifth stale copy). Audit `score.mjs`,
      `ledger.mjs`, `session-status.mjs`, `fleet-report.mjs` for any
      display or branch keyed on evidence grade and make each render
      `recorded` sensibly (expected: pass-through; verify with one
      assertion each where a grade string is printed). Run the full
      workspace test suite.
- [x] 3.3 Skill docs (repo `skills/forge/`): `phases/review.md` — the
      HARD-GATE describes the stamp (what `review-label` now writes, that
      it survives host pruning and decides when the host cannot answer,
      and that the below-floor branch still reads the file), and the "When
      there is no host record, this review file's wording decides" section
      narrows to the no-stamp legacy case; `phases/implement.md` and
      `docs/forge.md` mention the stamp where they mandate the label;
      `subagents/final-reviewer-prompt.md` "Write this line as if it
      decides" paragraph updated. Verification: `rg 'review-label'
      skills/forge` shows no page describing the label as print-only.

## 4. The partial-binding negative (D4 — added 2026-07-31, user-approved)

- [x] 4.1 `packages/cli/src/metrics/review-evidence.mjs` with
      `metrics/review-evidence.test.mjs` (test-first): `reviewEvidence`
      reports `partial: true` on an available answer when one or more of
      the session's bound host session ids resolved to no transcript on
      disk (`found` shorter than the deduped bound ids), `false`
      otherwise; unavailable answers carry `partial: false` as a
      placeholder for shape uniformity (read `available` first, as ever).
      The existing guards are untouched: unreadable bindings still refuse
      (F27), a fully-pruned binding still answers unavailable. Tests:
      two-bound-sessions fixture with older transcript deleted →
      `available: true, partial: true`; both on disk → `partial: false`;
      all pruned → unavailable (unchanged); update the module-header
      pruned-residual paragraph to name the flag.
- [x] 4.2 `packages/cli/src/review-census.mjs` +
      `review-census.test.mjs`, and one gate pin in
      `set-phase.test.mjs`: `hostFinalReview`'s absence-negative (bucket
      undefined — "the one genuine negative") is distinguished from the
      measured-stop negative; the census lets a valid `final` stamp
      override ONLY the absence-negative and ONLY when
      `evidence.partial === true`, answering `independent`/`recorded`.
      Tests: partial + absence-negative + stamp → `recorded` (prose
      untouched); partial + all-stopped final bucket + stamp → `self`/
      `host` (measured stop wins); complete binding + absence-negative +
      stamp → `self`/`host` (printed label with no dispatch is not a
      review); partial + absence-negative + NO stamp → `self`/`host`
      (unchanged). Gate pin: partial-binding fixture (two bound ids, one
      transcript on disk) + stamp + final review file → `forge phase
      done` passes with frozen `{independent, recorded}`.

## 5. Product loop acceptance

- [x] 5.1 `scripts/e2e/harness-portability.mjs`: new scenario
      `review-stamp-decides` — in a scratch project: control first (no
      stamp, pruned host, self-declaring file → `self`/`inferred`,
      high-risk gate refuses), then `forge review-label final` (assert
      `reviews/dispatches.json` exists with the resolved model), prune the
      host record, and `forge phase done` passes with digest
      `evidence=recorded`; finally a stamped **sub-floor** host record
      still refuses (D3, guarding review-evidence-substance's fix). Add
      the step to `e2e.json`; acceptance output is a green
      `forge e2e run`.
