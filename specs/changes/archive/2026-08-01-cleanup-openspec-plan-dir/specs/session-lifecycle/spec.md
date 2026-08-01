# Delta for session-lifecycle

## ADDED Requirements

### Requirement: Cleanup plan root follows the project plan engine

When resolving whether an `openspecChange` names a live change directory,
cleanup SHALL use the project plan engine root from
`resolveProjectPlanEngine` (with user-default disabled). An OpenSpec project
whose config has `plan.engine` of `openspec` and no `plan.dir` SHALL look
under `openspec/changes/<name>/`, not `specs/changes/<name>/`.

#### Scenario: OpenSpec engine without plan.dir retains plan session

- GIVEN `.forge/config.json` contains `{ "plan": { "engine": "openspec" } }`
- AND an unfinished aged session with `openspecChange` `example-change`
- AND `openspec/changes/example-change/` exists
- AND the session directory holds only scaffold files
- WHEN bare `forge cleanup` runs
- THEN that session directory is not removed
