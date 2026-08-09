# Delta for Project Wiring

## ADDED Requirements

### Requirement: Portable declared CI matrix
The project SHALL keep tests portable across every operating system and Node version declared by its CI matrix. Tests of filesystem denial SHALL use deterministic coded failures rather than permission semantics unavailable on a declared host.

#### Scenario: Windows and Ubuntu enforce the same product assertions

- GIVEN the repository is tested on Ubuntu and Windows with supported Node versions
- WHEN the CI workflow runs lint, tests, and smoke checks
- THEN every required job completes without unexplained test failures
- AND platform-specific fixtures exercise the same production fail-closed behavior
- AND test portability changes do not weaken production error handling
