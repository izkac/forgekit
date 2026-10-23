# Test Runs Spec

## Purpose

Describe this capability.

## Requirements

### Requirement: Full tier-3 runs are serialized across sessions
`forge evidence --tier3` with scope `full` SHALL hold an exclusive lock for the
duration of the spawned command. The lock SHALL live at
`<git-common-dir>/forge/tier3.lock`, so every worktree of one repository shares
it, and at `<project>/.forge/tier3.lock` when the project is not a git
repository. While another live process holds it, the command SHALL wait and
print the holder's session slug, pid and start time. A lock whose holder pid is
not running SHALL be taken over. When the lock cannot be created for any other
reason the run SHALL proceed unlocked with a warning. Runs with any other scope
SHALL NOT take the lock.

#### Scenario: Second full run waits for the first
- GIVEN session A is running `forge evidence --tier3 -- <cmd>` in worktree W1
- WHEN session B runs `forge evidence --tier3 -- <cmd>` in worktree W2 of the same repository
- THEN B prints that it is waiting for A's slug and pid
- AND B's command starts only after A's run finishes

#### Scenario: Dead holder is taken over
- GIVEN a lock file naming a pid that is not running
- WHEN `forge evidence --tier3 -- <cmd>` runs
- THEN the command runs without waiting

#### Scenario: Lock cannot be created
- GIVEN the lock directory is not writable
- WHEN `forge evidence --tier3 -- <cmd>` runs
- THEN a warning is printed and the command runs and is stamped

#### Scenario: Scoped runs do not lock
- GIVEN another session holds the tier-3 lock
- WHEN `forge evidence --tier3 --scope group -- <cmd>` runs
- THEN the command runs without waiting

#### Scenario: Lock released on exit
- GIVEN a full run holding the lock
- WHEN the command exits or fails
- THEN the lock file is removed

#### Scenario: Interrupted run does not block the next one
- GIVEN a full run killed while holding the lock (Ctrl-C, task kill)
- WHEN another session starts a full run
- THEN it takes the lock over because the holder pid is no longer running

### Requirement: Tier-3 stamps record their scope
`forge evidence --tier3` SHALL accept `--scope full|failed-only|fix|group`,
default `full`, and SHALL record it as `scope` in the `verify-runs.jsonl`
stamp. Any other value SHALL be a usage error. `--scope` without `--tier3`
SHALL be a usage error. A stamp without a `scope` field SHALL be read as
`full`.

#### Scenario: Default scope
- WHEN `forge evidence --tier3 -- <cmd>` runs
- THEN the stamp has `scope: "full"`

#### Scenario: Unknown scope refused
- WHEN `forge evidence --tier3 --scope everything -- <cmd>` runs
- THEN it exits non-zero with a usage message and spawns nothing

### Requirement: Tier-3 verdict comes from the last full run
`forge status` (`proven.tier3`) SHALL judge tier 3 by the last `full` stamp.
A green full stamp SHALL be ok. A red full stamp followed by a green
`failed-only` stamp SHALL be ok and SHALL say it was rescued by a failed-only
re-run. `fix` and `group` stamps SHALL NOT change the verdict. With no full
stamp the verdict SHALL remain "not stamped".

#### Scenario: Load-induced failures rescued
- GIVEN a red full stamp, then a green failed-only stamp
- WHEN `forge status` runs
- THEN tier 3 reads ok via failed-only

#### Scenario: Fix stamp does not fake a full run
- GIVEN a red full stamp, then a green fix stamp
- WHEN `forge status` runs
- THEN tier 3 reads red

#### Scenario: Scoped stamp alone is not tier 3
- GIVEN only a green group stamp
- WHEN `forge status` runs
- THEN tier 3 reads not stamped

#### Scenario: Legacy stamp
- GIVEN a green stamp with no scope field
- WHEN `forge status` runs
- THEN tier 3 reads ok

### Requirement: Full suites run once per change
The Forge skill SHALL instruct the coordinator to: run diff-related tests (not
the full suite) at each task-group close, stamped `--scope group`; run the
leftover sweep before tier 3; run each affected workspace's full suite exactly
once; after a red full run, re-run only the failing files (`--scope
failed-only`); after sweep or review fixes, run only tests for what the fix
touched (`--scope fix`). A second full run SHALL be instructed only when a fix
touches test harness, setup, configuration, package manifests or lockfiles.
No skill file SHALL instruct re-running the full suite merely because code was
edited after verify evidence.

#### Scenario: Sweep fix after tier 3
- GIVEN tier 3 is green and the leftover sweep fixes a stale import
- WHEN the coordinator follows verify.md
- THEN it runs tests for the touched file with `--scope fix` and no full run

#### Scenario: Contradicting rule removed
- WHEN the skill tree is searched for "edited code after" together with "re-run tier 3"
- THEN no match remains
