# Delta for Test Guard

## ADDED Requirements

### Requirement: Seal refresh survives transient file errors
A legitimate Forge write that refreshes the integrity seal SHALL write the
seal atomically (temp file + rename) and SHALL retry the refresh up to three
times on EBUSY, EPERM or EACCES before giving up with a warning, so a
transient lock on Windows does not leave a stale seal that the next phase
check reads as tampering.

#### Scenario: Transient busy error
- GIVEN the seal write fails once with EBUSY
- WHEN a Forge command refreshes the seal
- THEN the retry succeeds and the seal matches the current files

### Requirement: Cache heals keep the seal current
Every Forge code path that rewrites `session.json` to heal a derived cache —
task progress reconciled from `tasks.md`, the cached score reconciled from the
scorecard — SHALL refresh the integrity seal after the write, so a legitimate
heal is never reported as tampering at the next phase boundary.

#### Scenario: Ticked task then phase transition
- GIVEN a sealed session and a newly ticked box in the change's `tasks.md`
- WHEN `forge status` (or the fleet/reminder read) heals `tasksComplete`
- AND the operator then runs `forge phase <next>`
- THEN the seal check passes

### Requirement: Results writers keep the seal current
Every Forge command that writes a sealed session artifact as its result —
`forge e2e run` (`e2e-results.json`), `forge gate check` (`gate-results.json`)
— SHALL refresh the integrity seal after the write, so running the product
loop or a gate never makes the next phase transition refuse as tampering.

#### Scenario: E2E run then phase transition
- GIVEN a sealed session with a change whose `e2e.json` has a passing step
- WHEN the operator runs `forge e2e run`
- AND then runs `forge phase <next>`
- THEN the seal check passes
