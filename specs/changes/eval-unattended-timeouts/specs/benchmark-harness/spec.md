# Delta for Benchmark Harness

## ADDED Requirements

### Requirement: The Forge arm is unattended
The runner SHALL append Forge-arm instructions that state the trial is
unattended: there is no human operator, the agent MUST NOT end a turn with a
clarifying question or wait for confirmation, and it MUST pick a reasonable
default and continue. The baseline arm SHALL NOT receive those unattended
rules. Reviews, tests, and the rest of the Forge workflow remain required.

#### Scenario: Staged Forge instruction forbids waiting on a human
- **GIVEN** the runner stages both arms of a canonical task
- **WHEN** the Forge `instruction.md` is read
- **THEN** it identifies the Forge arm and the Forge workflow
- **AND** it states the trial is unattended and that the agent must not end a
  turn with a clarifying question
- **AND** the baseline instruction does not mention the Forge workflow or the
  unattended rule
