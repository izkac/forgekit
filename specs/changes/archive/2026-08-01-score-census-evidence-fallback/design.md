# Design

## Decision

```js
const evidence = reviewEvidence({ session, env: process.env });
const live = reviewCensus(sessionDir, { evidence });
```

in both `scoreSession` and `appendSessionDigest` live paths. Frozen overlay
unchanged.

## Alternatives rejected

- Distinct grade for stamp-without-evidence — more surface; set-phase already
  passes evidence.
- Only fix score.mjs — ledger has the same live fallback.
