# Design — thorough-re-corpus

## Context

`isHighRiskText` / `suggestPaceFromSignals` gate whether a change hits the
money/auth review floor. F11 documents that narrowing without a corpus
regresses. W5 builds the corpus; it does not change the regex.

## Decisions

### D1 — Pin via `isHighRiskText`, not a private regex export

The public risk predicate is already exported. Exporting `THOROUGH_RE`
would freeze an implementation detail; the corpus cares about the
classification the rest of Forge uses.

### D2 — Fixture JSON with explicit expect sides

```json
{ "id": "F11-risky-1", "expect": "risky", "source": "F11", "text": "…" }
```

`expect: "risky"` ↔ `isHighRiskText(text) === true`; `"benign"` ↔ false.
Today's behaviour includes known over-escalations (bare "contract" in
ordinary English) — those rows are `risky` if the detector says so today.
The corpus records truth of the detector, not desired policy.

### D3 — Failure lists every flipped sentence

Aggregate mismatches; assert with a message that joins id + expect +
actual for each failure so a narrowing PR shows the full cost in one
diff.

### D4 — Mine archive prose, do not invent

Prefer sentences that already appear in this repo's archived change docs
plus F11's measured examples. Hard-wrapped variants: insert a newline
between qualifier and noun where F11 claimed the 0.3.24 form broke.

## Risks

- Corpus too small → false confidence. Mitigate: include all three F11
  risky quotes, ≥3 benign contract-in-English cases, ≥1 hard-wrap pair,
  ≥5 archive-sourced rows.
- Someone "fixes" F11 by editing expects instead of measuring. Mitigate:
  comment at top of fixture: expects pin *current* detector; changing
  expects requires citing a measured corpus review.
