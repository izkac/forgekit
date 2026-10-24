# Delta for Gate Fires

## ADDED Requirements

### Requirement: Every gate refusal is logged as a Gate fire
Every Forge gate refusal SHALL append one line `{ gate, sessionId, project, at }` to the machine-level
fires log `gate-fires.jsonl` beside the fleet registry directory. The done gate SHALL log one line
per failing sub-check. Logging SHALL never throw or change the refusal's exit code, and SHALL skip
scratch projects under the system temp dir unless `FORGEKIT_FLEET_DIR` is set.

#### Scenario: Refused done logs its sub-checks
- GIVEN a session with no verify evidence and incomplete tasks
- WHEN `forge phase done` refuses
- THEN the fires log gains `done:verify-evidence` and `done:tasks` lines carrying the session id

#### Scenario: Passing transition logs nothing
- GIVEN a transition every gate allows
- WHEN it succeeds
- THEN the fires log is unchanged

#### Scenario: Guard deny is a fire
- GIVEN a guarded test file during implement
- WHEN `forge guard check --file <it>` denies
- THEN a `test-guard` line is appended

### Requirement: Fire counts per gate across the fleet
`forge fires [--json] [--since <iso>]` SHALL list, per gate id, the fire count, distinct sessions
and the last fire time, read from the machine-level fires log. Every known gate id SHALL appear,
including those with zero fires; ids seen in the log but not known SHALL also appear.

#### Scenario: Zero-fire gates are listed
- GIVEN a log holding only `test-guard` fires
- WHEN `forge fires --json` runs
- THEN `test-guard` shows its count and every other known gate shows 0
