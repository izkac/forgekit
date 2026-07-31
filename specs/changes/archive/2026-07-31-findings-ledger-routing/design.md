# Design — findings-ledger-routing

## Decisions

### D1 — Token match, not NLP
Slug split on `-`; tokens of length ≥4 match against `change` (exact or
substring) or `text` (case-insensitive). Exact `change === slug` always hits.

### D2 — Advisory only
JSON field + stderr notice. Session creation never fails because of findings.

### D3 — Stale = 7 calendar days from `createdAt`
`ageDays` is floor((now - createdAt) / 86400000). Missing/invalid createdAt
excluded.

### D4 — Docs mirror CLI
Update finding CLI mentions to require `--kind` and `--severity`.
