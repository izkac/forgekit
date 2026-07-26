# Delta for E2E Harness

## ADDED Requirements

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
