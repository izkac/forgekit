# Score Census Evidence Fallback

## Why

`forge phase done` freezes a final-review verdict with host `reviewEvidence`
passed into `reviewCensus`. Mid-session `forge score` and the session digest
fall back to a live census when no frozen verdict exists — but those call sites
omitted evidence. A dispatch stamp alone then graded the final review
`recorded` / `independent` even when the host recorded that every final
dispatch was stopped (F63).

## What Changes

- `scoreSession` and `appendSessionDigest` pass
  `reviewEvidence({ session, env: process.env })` into live `reviewCensus`,
  matching `freezeReviewVerdict`.
- Frozen overlay still wins when present; stamp-without-evidence remains the
  fallback only when callers omit evidence (tests / older sites).

## Capabilities

- `review-evidence`: live score/ledger census consults host evidence
  (delta: `specs/review-evidence/spec.md`)

## Impact

Scorecards and digests for unfinished sessions become honest about measured
stops. No migration; no CLI flag changes.
