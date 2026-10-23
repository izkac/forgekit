# Delta for Session Lifecycle

## ADDED Requirements

### Requirement: Nested repositories get a base commit at session start
`forge new` SHALL record, in `session.nestedBaseCommits`, the HEAD commit of
every nested git repository found at most two directory levels below the
project root (a directory containing a `.git` entry), keyed by its posix path
relative to the root. `node_modules` and dot-directories SHALL NOT be scanned.
A repository whose HEAD cannot be read SHALL be omitted. With no nested
repositories the field SHALL be absent. `forge status` SHALL show the field
when present.

#### Scenario: Nested web repo
- GIVEN a project with a nested git repository at `volo_web/`
- WHEN `forge new demo` runs
- THEN `session.nestedBaseCommits["volo_web"]` equals that repository's HEAD

#### Scenario: No nested repos
- GIVEN a project with no nested git repository
- WHEN `forge new demo` runs
- THEN `session.nestedBaseCommits` is absent
