# E2E Harness Spec

## Purpose

The project's e2e harness recorded once in `.forge/config.json` and reused by
every later session: what it is, how to install what it needs, how to start it,
how to prove it, and where it lives. Covers what the record holds, the surfaces
that display it, and how a failing product loop points at machine-local
prerequisites a fresh checkout is missing.

Forge records and attributes; it never detects tools or installs anything — see
ADR-0001 (`docs/adr/0001-harness-prerequisites-are-recorded-not-detected.md`).

## Requirements

### Requirement: Recorded harness holds setup and probe
The recorded project harness SHALL be able to carry the command that proves it
(`probe`) and the machine-local prerequisites its probe runtime needs
(`setup`), alongside the existing description, start command, and location.
Both fields are optional; a harness recorded without them behaves exactly as
before.

#### Scenario: Recording with both flags
- GIVEN a project with `.forge/config.json`
- WHEN the operator runs `forge e2e harness --set "<desc>" --start "<cmd>" --probe "npm run test:e2e" --setup "npx playwright install chromium"`
- THEN `.forge/config.json` → `e2e.harness` contains `probe` and `setup`
- AND pre-existing config keys are preserved

#### Scenario: Surfaced wherever the harness is shown
- GIVEN a harness recorded with `setup` and `probe`
- WHEN the agent runs `forge e2e harness` or `forge e2e init`
- THEN the output lists `Setup:` and `Probe:` alongside `Start:` and `Location:`
- AND `forge e2e status` serializes both fields under `harness`

#### Scenario: Legacy harness prints unchanged
- GIVEN a harness recorded before this change (description/start/dir only)
- WHEN the agent runs `forge e2e harness`
- THEN no `Setup:` or `Probe:` row is printed

### Requirement: Failing loops name recorded prerequisites
When an executed product loop fails and the project records a harness `setup`
command, `forge e2e run` SHALL surface that command as the first thing to
suspect, so a missing probe runtime on a fresh checkout does not read as a code
regression. Forge SHALL NOT detect specific tools, check for installed
binaries, or run the setup command itself — the operator decides.

#### Scenario: Failing loop with a recorded setup
- GIVEN a project whose harness records `setup`
- WHEN `forge e2e run` has a failing step
- THEN the output names the recorded setup command as a possible cause
- AND the exit code is still 1, driven by the failing step alone

#### Scenario: No hint without a recorded setup
- GIVEN a project whose harness records no `setup`
- WHEN `forge e2e run` has a failing step
- THEN no prerequisite hint is printed

#### Scenario: No hint on a green loop
- GIVEN a project whose harness records `setup`
- WHEN `forge e2e run` is green
- THEN no prerequisite hint is printed

### Requirement: A harness is proven on the operator's machine
Forge guidance SHALL state that a harness proven only in the agent's
environment is not proven: anything the agent installed to make the probe pass
(browsers, drivers, images, toolchains) is absent from both the repository and
the operator's checkout, and MUST be recorded as `setup` when the harness is
recorded.

#### Scenario: Agent installs a probe runtime
- GIVEN an agent installs a browser or driver to make the probe pass
- WHEN it records the harness
- THEN the install command is recorded via `--setup`
- AND the skill text presents this as a tool-agnostic rule, not a
  Playwright-specific note

### Requirement: Product loop can be skipped without a grade penalty
Project disable (`e2e.disabled`) and session skip (`session.e2eSkip`) SHALL
skip the executed-run demand and award product-loop full credit (N/A). A
missing recorded harness SHALL NOT skip the loop. Agents SHALL NOT run
`forge e2e disable`. Agents MAY run `forge e2e skip` only when the user asked
in that conversation.

#### Scenario: Project disable skips the executed run
- GIVEN `.forge/config.json` has `e2e.disabled` set to a reason
- WHEN `forge integrity-check` / `forge e2e check` / `forge score` run
- THEN the executed green run is not demanded
- AND product_loop scores 20/20 with an N/A note naming the project skip

#### Scenario: Session skip skips the executed run
- GIVEN the active session has `e2eSkip` set to a reason
- WHEN `forge integrity-check` / `forge e2e check` / `forge score` run
- THEN the executed green run is not demanded
- AND product_loop scores 20/20 with an N/A note naming the session skip

#### Scenario: Missing harness is not a skip
- GIVEN the project has no recorded `e2e.harness`
- AND e2e is not disabled and the session is not skipped
- AND the spine has rows
- WHEN `forge integrity-check` runs
- THEN the executed green run is still demanded

### Requirement: BLOCKED does not fail a proven or skipped loop
A line-owned `BLOCKED` marker in `verify-evidence.md` SHALL fail integrity,
zero product_loop, and mark health red only when the loop is still required.
It SHALL NOT apply when the loop is skipped or `e2e-results.json` is green
and current.

#### Scenario: Green run plus BLOCKED heading
- GIVEN a green, current `e2e-results.json`
- AND `verify-evidence.md` contains a line-owned `BLOCKED` heading
- WHEN integrity, score, and health run
- THEN integrity does not fail for BLOCKED
- AND product_loop is not zeroed for BLOCKED
- AND health is not red for BLOCKED

#### Scenario: Skip plus BLOCKED heading
- GIVEN project disable or session `e2eSkip`
- AND `verify-evidence.md` contains a line-owned `BLOCKED` heading
- WHEN integrity, score, and health run
- THEN BLOCKED is ignored for the loop

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
