# Design — review-guidance-doc-contract (F36)

## Test

`packages/cli/src/review-guidance-contract.test.mjs`:

1. Locate `skills/forge/phases/implement.md` relative to package (repo root via
   `../../skills/...` from `packages/cli/src`, with fallback to
   `vendor/skills/forge/phases/implement.md` when packed).
2. Parse the closed list: after `list is **closed**:` take backtick spans until
   the paragraph ends (or the next blank line / next `**` heading).
3. For each phrase `p`, write `final-review.md` (or group-review) whose first
   paragraph is `Reviewer: ${p}` or the phrase alone when it already includes
   `Reviewer:` / `APPROVED (pace` shapes — use the phrase as a whole line in the
   attribution region.
4. Assert `reviewCensus(dir).finalReview === 'self'` (or selfChecks >= 1 for
   group files — prefer final-review for one clear field).

Also one negative: body `Looks good. Independent pass.` → not self.

## Regex

If RED shows a doc phrase the regex misses, extend `SELF_REVIEW_RE` to match
the published string — docs win.
