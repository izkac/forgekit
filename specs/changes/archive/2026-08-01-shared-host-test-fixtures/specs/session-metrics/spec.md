# Delta for session-metrics

## ADDED Requirements

### Requirement: Host-tree test fixtures have one shared owner

Automated tests that plant Claude `~/.claude/projects` host trees for
review-evidence, metrics collect, and review-census SHALL share one fixture
module rather than maintaining independent copies of `plantHost` /
`plantSidecars` / `assistantLine`.

#### Scenario: Three suites import the same planter

- GIVEN the shared host-tree fixture module
- WHEN review-evidence, collect, and review-census tests plant a host session
- THEN they use the shared module's exports
- AND the existing suite assertions still pass
