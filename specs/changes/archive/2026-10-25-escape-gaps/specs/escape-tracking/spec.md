# Delta for escape-tracking

## ADDED Requirements

### Requirement: Commit ranges cover nested repositories
When a session reaches done, the system SHALL record a Commit range for each nested repository
listed in the session's `nestedBaseCommits` whose HEAD moved (`base..head`), and `forge escapes`
SHALL search every recorded range in its own repository. Each candidate SHALL name its repository.

#### Scenario: Code committed in a nested repo
- GIVEN a session started with nested repo `app` at commit B
- AND the change commits a line L in `app`
- WHEN the session reaches done and a later commit in `app` within 14 days rewrites L
- THEN `forge escapes` lists that commit for the session with repository `app`

#### Scenario: Untouched nested repo
- GIVEN a nested repo whose HEAD did not move during the session
- WHEN the session reaches done
- THEN no range is recorded for it

### Requirement: Ranges are inferred for sessions recorded before per-repository ranges
For a done session with no recorded nested ranges, the system SHALL infer a range for each nested
repository from the commits made in it between the session's start and end, attribute a commit
inside several sessions' windows to the shortest of them, and mark such candidates `inferred`.
`forge escapes report` SHALL show inferred candidates separately.

#### Scenario: Old Volo-style session
- GIVEN a done session with only start/end times and a nested repo with commits inside that window
- WHEN `forge escapes` runs
- THEN candidates against those commits are listed and marked `inferred`

#### Scenario: Overlapping sessions
- GIVEN two done sessions whose windows both contain commit C
- WHEN ranges are inferred
- THEN C belongs only to the session with the shorter window

### Requirement: Replay tests verify candidates
`forge escapes verify` SHALL, for each undecided candidate whose fix commit added or modified a
test file matched by an `escapes.replay` rule, run the rule's command twice in throwaway worktrees —
on the fix's parent with the fix's test file copied in, and on the fix — and SHALL record: auto-
confirmed when the first fails and the second passes; `environment` when the second fails or the
first fails with a module-resolution or syntax error; `not-reproduced` when the first passes; and
leave the candidate undecided with a reason when no rule matches, no test exists or a run times out.
It SHALL never dismiss a candidate, never modify the operator's working tree, remove every worktree
it created, and refuse to run without the exec opt-in.

#### Scenario: Escape proven by its test
- GIVEN a candidate whose fix commit adds a test that fails before the fix and passes after it
- WHEN `forge escapes verify --all` runs with a matching rule and exec opted in
- THEN the candidate is confirmed with `auto: true`, the command and both exit codes

#### Scenario: Test passes on the old code
- GIVEN a candidate whose fix's test also passes before the fix
- WHEN verify runs
- THEN the candidate stays undecided and is tagged `not-reproduced`

#### Scenario: Test needs code the fix added
- GIVEN a fix's test that fails before the fix with "Cannot find module"
- WHEN verify runs
- THEN the candidate is tagged `environment`, not confirmed

#### Scenario: No exec opt-in
- GIVEN exec is not opted in and there is no TTY
- WHEN `forge escapes verify --all` runs
- THEN it refuses and runs nothing

### Requirement: Escape rate by forgekit release
`forge escapes report --by version` SHALL group done sessions by the forgekit version recorded on
them and show done, escaped and rate per version, with sessions lacking a version under `unknown`.

#### Scenario: Two releases
- GIVEN done sessions recorded under versions 0.3.66 and 0.3.67
- WHEN `forge escapes report --by version` runs
- THEN it shows one row per version plus `unknown` for sessions without one
