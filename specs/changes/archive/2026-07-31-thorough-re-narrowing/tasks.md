# Tasks

## 1. RED — corpus + preferences pins for the new policy

- [x] 1.1 Update `packages/cli/src/fixtures/thorough-re-corpus.json`: set
      `arch-never-block-contract` expect to `benign`; note the measured
      rationale in the row or fixture comment. Leave all other expects.
      Add/adjust `packages/cli/src/preferences.test.mjs` so the old
      “unqualified contract fails closed” case is replaced by: F11 risky +
      hard-wrap → true; bare “same contract as readLedger” and
      “must never block work” contract → false. Do **not** change
      `THOROUGH_RE` yet. Verify RED:
      `node --test packages/cli/src/thorough-re-corpus.test.mjs packages/cli/src/preferences.test.mjs`
      (corpus and/or preferences assertions fail against current regex).

## 2. GREEN — narrow THOROUGH_RE

- [x] 2.1 In `packages/cli/src/preferences.mjs`, replace bare
      `contract|contracts` with the approved qualifier+`\s+` form (and
      `contracts?\s+(?:test|tests|testing|breach)`). Update the comment
      block above `THOROUGH_RE` to describe the measured policy and point
      at the corpus. Same tier-2 command exits 0. Resolve F11 with a short
      note pointing at this change.
