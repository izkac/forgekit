# Delta for session-lifecycle

## ADDED Requirements

### Requirement: Checkpoint refuses foreign untracked change dirs

`forge checkpoint` SHALL refuse to stage when the working tree has untracked
paths under `<plan.dir>/changes/<other>/` where `<other>` is not the session's
`openspecChange` and is not `archive`. The refusal SHALL list those paths.
It SHALL NOT commit another change's in-progress untracked files under this
session's checkpoint subject.

#### Scenario: Sibling untracked change dir blocks checkpoint

- GIVEN an active session with openspecChange `my-change`
- AND an untracked file under `specs/changes/other-change/`
- WHEN forge checkpoint runs
- THEN it exits non-zero without creating a commit
- AND the message names the foreign path(s)
