# Delta for Checkpoint Safety

## ADDED Requirements

### Requirement: Checkpoint scopes to this session's work under fleet overlap
When a second unfinished session (phase not `done` or `skipped`) shares the
working tree, `forge checkpoint` SHALL NOT stage changes that lie outside the
committing session's own change directory unless those paths are named
explicitly. Specifically:

- With no other unfinished session present, staging is unchanged: `git add -A`
  excluding `.forge/` scratch, with the existing refusal on untracked paths under
  a foreign change directory preserved.
- With another unfinished session present and no `--path` given, checkpoint SHALL
  refuse when any pending change lies outside the committing session's change
  directory. The refusal SHALL name the offending paths and SHALL identify those
  that belong to another open session's change directory. A checkpoint whose only
  pending changes are the session's own SHALL proceed.
- `forge checkpoint --path <p>` (repeatable) SHALL stage only the named paths
  plus the session's own change directory, leaving all other working-tree changes
  unstaged. A `--path` value that resolves under another open session's change
  directory SHALL be refused.

In every case checkpoint SHALL NOT commit a path under another open session's
change directory, and SHALL continue to never push and to refuse on the default
branch.

#### Scenario: A foreign session's tracked edit is not swept in

- **GIVEN** two unfinished sessions share a working tree
- **AND** the other session has a tracked modification to a shared source file
- **WHEN** `forge checkpoint` runs for this session with no `--path`
- **THEN** it refuses without creating a commit
- **AND** the message names the shared source file

#### Scenario: Explicit paths scope the commit

- **GIVEN** the same two-session working tree with changes to this session's file
  and to a shared file
- **WHEN** `forge checkpoint --path <this session's file>` runs
- **THEN** the commit contains that file and the session's own change directory
- **AND** the shared file is not staged

#### Scenario: A named path may not grab another session's plan

- **GIVEN** two unfinished sessions share a working tree
- **WHEN** `forge checkpoint --path <the other session's change dir>` runs
- **THEN** it refuses without creating a commit

#### Scenario: Only this session's changes still checkpoints cleanly

- **GIVEN** another unfinished session exists but has no pending working-tree changes
- **AND** this session has changes only under its own change directory
- **WHEN** `forge checkpoint` runs with no `--path`
- **THEN** it commits those changes

#### Scenario: A single open session is unaffected

- **GIVEN** this is the only unfinished session in the working tree
- **WHEN** `forge checkpoint` runs with no `--path`
- **THEN** staging is `git add -A` excluding scratch, exactly as before
- **AND** a commit is created
