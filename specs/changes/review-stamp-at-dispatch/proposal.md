# Review Stamp At Dispatch

## Why

The money/auth final-review verdict rests on two evidence sources, and both
fail in a measured, recurring way. The host's dispatch record (`evidence:
'host'`) is authoritative but lives in the host's transcript directory, which
prunes in days — a reviewer that genuinely ran becomes invisible, and the
verdict silently falls back to prose (F58, the residual F27 handed to F12).
The prose fallback (`evidence: 'inferred'`) reads text written by the party
being judged; two attempts to harden it were reverted after each was measured
wrong in both directions, and its known weaknesses (F11/F18/F19) now carry
gate-deciding traffic (F51). F12's twice-confirmed conclusion: prose cannot
measure authorship — the fix is a record Forge writes itself, at dispatch
time, in a place the host cannot prune.

## What Changes

- `forge review-label <unit>` — the command a HARD-GATE already requires at
  every reviewer dispatch — additionally writes a **stamp** to
  `.forge/sessions/<id>/reviews/dispatches.json`: unit, label, session id,
  timestamp, and the model resolved in-process at the reviewer's tier.
  Stdout stays byte-identical; a failed stamp write warns and never blocks
  the label.
- `reviewCensus` gains the third evidence source, filling the `'recorded'`
  grade reserved since rule 4. Precedence **host > recorded > inferred**:
  when host evidence cannot answer *and* shows no well-formed record of the
  `final` unit, a valid stamp decides `{ finalReview: 'independent',
  finalReviewEvidence: 'recorded' }` and the prose is not consulted.
  `CENSUS_RULE` bumps to 5.
- The stamp never answers on the below-substance-floor branch: a well-formed
  `final` bucket with `maxRequests < FINAL_REVIEW_REQUEST_FLOOR` keeps
  routing to prose, so the stamp cannot resurrect the one-request forgery
  that review-dispatch-substance killed (F33).
- Gate, freeze, scorecard and ledger consume the new grade without
  structural change; the four comment blocks that name F12 as an unbuilt
  owner (per F58) are updated to point at the shipped mechanism.
- Skill docs (`skills/forge/phases/review.md` HARD-GATE and neighbours)
  describe the stamp and narrow the "your wording decides" warnings to the
  no-stamp legacy case.

## Capabilities

- `review-evidence`: dispatch-time stamping and the recorded evidence grade
  (delta: `specs/review-evidence/spec.md`)

## Impact

- Code: `packages/cli/src/review-stamp.mjs` (new),
  `review-label-cli.mjs`, `review-census.mjs`, comment-level updates in
  `metrics/review-evidence.mjs`, `set-phase.mjs`; consumer audit in
  `score.mjs`, `ledger.mjs`, `session-status.mjs`, `fleet-report.mjs`.
- Docs: `skills/forge/phases/review.md`, `phases/implement.md`,
  `subagents/final-reviewer-prompt.md`, `docs/forge.md`.
- Risk: this decides the money/auth gate — high-risk floor applies; per-task
  independent review and an independent final review are mandatory.
- Migration: none. Sessions with no stamp behave exactly as today; old
  digests are unaffected (`rule` field already versions the classifier).
- Findings resolved: F12 (primary), F58 (scope note satisfied). Traffic onto
  F11/F18/F19 (F51) shrinks as stamps appear but those findings stay open.
