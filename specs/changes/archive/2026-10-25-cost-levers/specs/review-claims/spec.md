# Delta for review-claims

## ADDED Requirements

### Requirement: Blocking review claims carry evidence
A Critical or Important item, spec gap or runtime-integrity failure in a review SHALL count
as blocking only when it carries one of: a failing command (argv and exit code); a quoted
spec requirement with the location where it is missing; or a concrete scenario with a
`file:line` location and expected vs actual behavior. `forge review-check <file>` SHALL list
each blocking item as backed or downgraded to Minor and print the effective verdict.

#### Scenario: Unbacked important claim
- GIVEN a REJECTED review whose only Important item has no evidence line
- WHEN `forge review-check` runs on it
- THEN the item is listed as downgraded to Minor and the effective verdict is APPROVED

#### Scenario: Backed by a failing command
- GIVEN an Important item with `Command: npm test -- foo → exit 1` and output lines
- WHEN `forge review-check` runs
- THEN the item is backed and the effective verdict stays REJECTED

#### Scenario: Backed by a scenario
- GIVEN a Critical item with `Scenario:`, `At: src/auth.mjs:42`, `Expected:` and `Actual:`
- WHEN `forge review-check` runs
- THEN the item is backed

#### Scenario: Approved review
- GIVEN an APPROVED review with Minor items only
- WHEN `forge review-check` runs
- THEN nothing is downgraded and the verdict stays APPROVED

### Requirement: Only backed claims weigh on the session
The review census and the scorecard SHALL count a review as a rejection only when it has at
least one backed blocking item. Downgrading SHALL NOT remove a required review: the
high-risk and final-review floors still require the dispatch.

#### Scenario: Unbacked rejection
- GIVEN a group review REJECTED with no backed items
- WHEN the census counts rejections
- THEN the review counts as approved with minor findings

#### Scenario: Unparsed rejection fails safe
- GIVEN a review whose verdict is REJECTED (or NOT READY) but which has no findings written as list items under a Critical, Important or Minor heading
- WHEN `forge review-check` or the census reads it
- THEN it stays REJECTED, with a note that its findings could not be checked — an unreadable review never turns into an approval

### Requirement: Reviewers see refuted claims
Reviewer briefs SHALL include a `{KNOWN_FALSE}` block from
`forge refute list --md --for-diff <range>`: every refutation from this session plus up to
20 entries from `.forge/known-false.jsonl` whose claim or actual text mentions the basename
of a file the range changes, most recent first.

#### Scenario: Project entry matches a changed file
- GIVEN `.forge/known-false.jsonl` has an entry whose claim mentions `checkpoint.mjs`
- AND the range changes `packages/cli/src/checkpoint.mjs`
- WHEN `forge refute list --md --for-diff <range>` runs
- THEN the entry appears in the block

#### Scenario: Cap
- GIVEN 30 project entries match changed files
- WHEN the block is built
- THEN it holds this session's refutations plus the 20 most recent matches
