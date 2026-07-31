# Thorough RE Narrowing

## Why

Finding F11 (reopened; was F3) exists because bare `contract` in `THOROUGH_RE`
escalates ordinary software English about a function's promise to thorough
pace and the independent-review floor. The 0.3.24 narrowing was reverted:
it missed F11's risky examples (`public` / `data` / `OpenAPI` contract) and
its qualifiers required a single space or hyphen, so 80-column hard-wrapped
plan prose disarmed them at a line break. The corpus prerequisite shipped
(`thorough-re-corpus`); this change is the measured narrowing that corpus
was built to enable.

## What Changes

- Replace bare `contract|contracts` in `THOROUGH_RE` with qualifier + `\s+`
  forms (and the existing `contracts?` + test/breach family), so hard-wrap
  between qualifier and noun still matches.
- Update the one corpus expect that deliberately flips
  (`arch-never-block-contract` → benign) and retarget
  `preferences.test.mjs` contract assertions to the new policy.
- Resolve F11.

## Capabilities

- `pace-signals`: measured THOROUGH_RE narrowing against the thorough-re
  corpus (delta: `specs/pace-signals/spec.md`)

## Impact

- Code: `packages/cli/src/preferences.mjs`, `preferences.test.mjs`,
  `fixtures/thorough-re-corpus.json`, corpus test stays green.
- Risk: thorough pace / money-auth hard floor still apply to real money/auth
  signals; false negatives on contract risk are the failure mode — corpus
  gates shipping.
- Migration: none. Sessions already resolved stay as they were; only new
  `suggestPaceFromSignals` / `isHighRiskText` calls change.
- Findings: resolve F11.
