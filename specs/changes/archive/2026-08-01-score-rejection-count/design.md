# Design — score-rejection-count

## Decision

```js
const REJECTION_RE =
  /(?:\bRound\s+\d+[^\n]*\bREJECTED\b|\*\*Verdict:\s*REJECTED\*\*)/i;
```

Per-file still `+= 1` if any match (unchanged aggregation).

## Alternatives rejected

- Last-verdict-token only — harder, and Round markers already encode rounds.
- Count every `## Round N — REJECTED` occurrence for multi-round files —
  nicer later; F59's observed bug is false positives from instructions, not
  under-count of multi-round files.

## Risks

Odd prose "Round 1 was REJECTED in discussion" could still match — rare;
prefer over-count of genuine narrative over under-count of real rounds.
