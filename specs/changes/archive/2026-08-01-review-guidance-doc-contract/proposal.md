# Review Guidance Doc Contract

## Why

The closed list of self-declaration phrases in `phases/implement.md` is checked
by hand against `SELF_REVIEW_RE` in `review-census.mjs` (F36). A regex edit can
silently invalidate the published guidance.

## What Changes

- Add a doc-contract test that extracts the closed-list phrases from
  `skills/forge/phases/implement.md` and asserts each grades as self via
  `reviewCensus`
- Fix regex only if a published phrase fails

## Capabilities

- `review-evidence`: published self-phrase list stays true (delta)

## Impact

Test (+ optional regex). Resolve F36.
