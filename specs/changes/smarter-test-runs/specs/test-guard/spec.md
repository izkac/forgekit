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
