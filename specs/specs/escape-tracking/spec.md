# Escape Tracking Spec

## Purpose

Describe this capability.

## Requirements

### Requirement: Escape candidates from blame overlap
`forge escapes` SHALL list, for each done Forge session of this repository (its `.forge/sessions.jsonl`
done rows and fleet registry done entries for the same repository, deduped by session id), the
Escape candidates: non-merge commits on the scanned ref (default HEAD), not reachable from the
range head, committed within 14 days after done, that modify or delete at least one line which
`git blame` of that commit's parent attributes to a commit in the session's Commit range.
Commits in the range and commits whose subject starts `forge(<slug>)` SHALL be skipped. Files under
the plan-engine directory and `.forge/` SHALL be ignored. A session with no recorded range SHALL use
one inferred from its `forge(<slug>):` commits, or be reported as skipped when none exist. Pairs
already decided SHALL not be listed again.

#### Scenario: A fix to a change line is a candidate
- GIVEN a done session whose range added line L to `src/a.js`
- WHEN a later commit within 14 days rewrites L
- THEN `forge escapes` lists that commit for the session

#### Scenario: Unrelated or late commits are not candidates
- GIVEN the same session
- WHEN a later commit only edits lines the change did not add, or lands more than 14 days after done
- THEN it is not listed

#### Scenario: Deleting a change line is a candidate
- GIVEN the same session
- WHEN a later commit deletes L
- THEN it is listed

### Requirement: Operator confirms or dismisses each candidate
The operator SHALL confirm or dismiss each candidate with one keystroke in an interactive terminal
or with `forge escapes confirm|dismiss <session> <commit>`. Confirming SHALL require a replay test
path: the fix commit's own test file when it touched one, otherwise a path the operator supplies
that exists in the fix commit's tree or the working tree; with neither, confirm SHALL refuse.
Decisions SHALL persist in `.forge/escapes.jsonl` under the ledger lock, one line per
(session, commit), a re-decision replacing the earlier line.

#### Scenario: Confirm takes the fix commit's test
- GIVEN a candidate commit that also added `test/a.test.js`
- WHEN the operator confirms it without `--test`
- THEN the ledger line is `confirmed` with `replayTest: test/a.test.js`

#### Scenario: Confirm without any test refuses
- GIVEN a candidate commit touching no test file
- WHEN the operator confirms it without `--test`
- THEN the command exits non-zero and writes nothing

### Requirement: Escape rate over time across the fleet
`forge escapes report [--json]` SHALL report, per month of done and per pace, the number of done
sessions, the number with at least one confirmed Escape, their ratio (the Escape rate) and how many
sessions still have an open 14-day window, plus the same four figures in total, aggregated over this
project and every fleet registry project still on disk, deduped by session id. A session's pace SHALL
be the one recorded for it at done (its `sessions.jsonl` row, else its fleet registry entry), or
`unknown` when none was recorded. Paces SHALL be ordered thorough, standard, brisk, lite, then any other
recorded value, with `unknown` last.

#### Scenario: Rate per month
- GIVEN two done sessions in October, one with a confirmed Escape
- WHEN `forge escapes report --json` runs
- THEN October shows done 2, escaped 1, rate 0.5

#### Scenario: Rate per pace
- GIVEN done sessions at standard (two, one with a confirmed Escape), brisk (one) and one with no recorded pace
- WHEN `forge escapes report --json` runs
- THEN `byPace` lists standard done 2 escaped 1 rate 0.5, brisk done 1 rate 0, unknown done 1, in that order

### Requirement: Outside-plan flag on Escape candidates
Each Escape candidate SHALL carry `outsidePlan`: the subset of its hit files whose basename appears in
none of the change's own plan documents — the files under the plan-engine directory that the Commit
range adds or modifies, read at the range head. When the range holds no plan documents, `outsidePlan`
SHALL be empty. The flag SHALL NOT hide, reorder or change any candidate. `forge escapes [list]` and the
interactive prompt SHALL print the flagged files as a possible sweep (F16).

#### Scenario: A swept-in file is flagged
- GIVEN a done session whose plan names `src/a.js` and whose range also added lines to `notes.md`
- WHEN later commits within 14 days rewrite a line of each file
- THEN both commits are listed, the `notes.md` one with `outsidePlan: ["notes.md"]`, the `src/a.js` one with `outsidePlan: []`

#### Scenario: No plan documents, no flag
- GIVEN a done session whose range holds no plan-engine files
- WHEN a later commit rewrites one of its lines
- THEN the candidate is listed with `outsidePlan: []`

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
