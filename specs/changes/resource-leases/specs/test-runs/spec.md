# Delta for Test Runs

## MODIFIED Requirements

### Requirement: Full tier-3 runs are serialized across sessions
`forge evidence --tier3` with scope `full` SHALL hold the built-in lease `tier3` for the duration of
the spawned command. The lease SHALL live at `<git-common-dir>/forge/leases/tier3.lock`, so every
worktree of one repository shares it, and at `<project>/.forge/leases/tier3.lock` when the project
is not a git repository. While another live process holds it, the command SHALL wait without a time
limit and print the holder's session slug, pid and start time. A lease whose holder pid is not
running SHALL be taken over. When the lease cannot be created for any other reason the run SHALL
proceed unlocked with a warning. Runs with any other scope SHALL NOT take the `tier3` lease.

#### Scenario: Second full run waits for the first
- GIVEN session A is running `forge evidence --tier3 -- <cmd>` in worktree W1
- WHEN session B runs `forge evidence --tier3 -- <cmd>` in worktree W2 of the same repository
- THEN B prints that it is waiting for A's slug and pid
- AND B's command starts only after A's run finishes

#### Scenario: Dead holder is taken over
- GIVEN a `tier3.lock` naming a pid that is not running
- WHEN `forge evidence --tier3 -- <cmd>` runs
- THEN the command runs without waiting

#### Scenario: Lock cannot be created
- GIVEN the lease directory is not writable
- WHEN `forge evidence --tier3 -- <cmd>` runs
- THEN a warning is printed and the command runs and is stamped

#### Scenario: Scoped runs do not lock
- GIVEN another session holds the `tier3` lease
- WHEN `forge evidence --tier3 --scope group -- <cmd>` runs
- THEN the command runs without waiting

#### Scenario: Lock released on exit
- GIVEN a full run holding the lease
- WHEN the command exits or fails
- THEN `tier3.lock` is removed

#### Scenario: Interrupted run does not block the next one
- GIVEN a full run killed while holding the lease (Ctrl-C, task kill)
- WHEN another session starts a full run
- THEN it takes the lease over because the holder pid is no longer running

## ADDED Requirements

### Requirement: Evidence runs take matching configured leases
`forge evidence` SHALL take every configured lease whose `match` pattern hits its command, in lease
name order, before taking `tier3`, and SHALL release them when the command exits. These waits use
each lease's `waitMs`; on expiry the run SHALL fail without stamping and name the busy lease.

#### Scenario: Evidence command touches the database
- GIVEN `leases.db.match` is `["db:migrate"]` and process A holds lease `db`
- WHEN `forge evidence --tier2 -- npm run db:migrate` runs
- THEN it waits for A before running the command

#### Scenario: Busy past the wait
- GIVEN `leases.db` has `waitMs: 500` and process A holds lease `db`
- WHEN `forge evidence --tier2 -- npm run db:migrate` runs
- THEN it exits non-zero naming lease `db`
- AND no evidence stamp is written
