# Delta for E2E Harness

## MODIFIED Requirements

### Requirement: Step evidence fingerprints

Executed step results (e2e and gate runs) SHALL additionally record, per
step, a SHA-256 digest of the combined output (`outputSha256`) and the
resolved `cwd` and `shell` — without changing any existing result field.

#### Scenario: Fingerprints present in results

- GIVEN an `e2e.json` (or gates.json) with runnable steps
- WHEN `forge e2e run` (or `forge gate check`) executes them
- THEN each executed step's result includes `outputSha256`, `cwd`, and
  `shell`

#### Scenario: Existing readers unaffected

- GIVEN result files written with the new fields
- WHEN existing consumers (integrity gate, status, score) read them
- THEN behavior is unchanged (additive fields only)
