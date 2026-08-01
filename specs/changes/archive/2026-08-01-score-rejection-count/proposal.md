# Score rejection count honesty (F59)

## Why

`reviewCensus` counts a rejection whenever `\bREJECT(ED)?\b` appears anywhere
in a review file. Reviewers who recite "REJECT if any of: …" and then
**APPROVE** inflate the scorecard note (e.g. "5 rejection rounds" when two
real Round-1 REJECTED → Round-2 APPROVED cycles happened). Finding **F59**.

## What Changes

- Count a rejection only on structural markers: `Round <n> … REJECTED` or
  `**Verdict: REJECTED**` (case-insensitive). Instructional "REJECT if" prose
  does not count.
- Resolve F59.

## Capabilities

- `review-evidence`: rejection census ignores instructional REJECT prose
  (delta: `specs/review-evidence/spec.md`)

## Impact

- Code: `packages/cli/src/review-census.mjs` (+ tests). Score/ledger consume
  `census.rejections` unchanged.
- Findings: resolve F59.
