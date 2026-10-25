# Delta for dispatch-budget

## ADDED Requirements

### Requirement: The plan's dispatch count is projected against a budget
When `forge phase implement` records the plan, the system SHALL project the session's
subagent dispatches from `tasks.md` (work units, group reviewers under the resolved pace,
one final review) and SHALL print a warning naming the largest contributors when the
projection exceeds `budget.subagents` from `.forge/config.json` (default 15). The system
SHALL NOT refuse the transition because of the budget.

#### Scenario: Plan over budget
- GIVEN a plan of 6 groups with 5 tasks each at standard pace and no budget configured
- WHEN `forge phase implement --tasks-total 30` runs
- THEN it prints a warning with the projected count, the budget 15 and the groups that add the most dispatches
- AND the phase becomes implement

#### Scenario: Plan within budget
- GIVEN a plan of 2 groups with 3 tasks each
- WHEN `forge phase implement` runs
- THEN no budget warning is printed

#### Scenario: Direct plan
- GIVEN a session with no `tasks.md` groups
- WHEN `forge phase implement` runs
- THEN the projection is one implementer plus the final review and no warning is printed

### Requirement: The running count is visible
The running count SHALL be the number of `decision: "allow"` or `decision: "rewrite"` lines (a
rewritten dispatch still runs) in the session's existing
`dispatches.jsonl` (written today by the model hook; this change adds no hook behavior and
the budget never causes a denial).

`forge status` and the session reminder SHALL show `dispatches <n>/<budget>`, SHALL add one
warning line when n exceeds the budget, and SHALL show `?` instead of n when the log is
missing or unreadable. The `sessions.jsonl` digest SHALL record projected, actual and budget.

#### Scenario: Over budget mid-implement
- GIVEN a session whose log holds 17 dispatches and budget 15
- WHEN `forge status` runs
- THEN it shows `dispatches 17/15` and one warning line

#### Scenario: Unreadable log
- GIVEN a session whose `dispatches.jsonl` cannot be read
- WHEN `forge status` runs
- THEN it shows `dispatches ?/15`, never `0/15`
