# Delta for Brainstorm Interview

## ADDED Requirements

### Requirement: Durable answers are offered for promotion

At the close of a brainstorm (After the Design), the skill SHALL instruct the
agent to scan the interview's answers for permanent project truths — standing
preferences, invariants, vocabulary — as opposed to one-change decisions, and to
offer, with explicit user consent, promoting each to `CONTEXT.md` (domain
terms), `AGENTS.md` (agent workflow rules), or an `ADR-candidate:` entry in
`decisions.md`. Promotion SHALL never happen silently.

#### Scenario: Standing preference offered for promotion

- GIVEN the user answered "background work always goes through the jobs
  package — never ad-hoc timers" during the interview
- WHEN the design is approved
- THEN the agent offers to record that rule in `AGENTS.md`, and writes it only
  after the user agrees

#### Scenario: One-change decision is not offered

- GIVEN an answer that only scopes this change ("use a modal here, not a page")
- WHEN the close runs
- THEN no promotion is offered for it

### Requirement: Phase doc names the plan gate

`phases/brainstorm.md` SHALL document that `forge phase plan` refuses after a
brainstorm without the `## Assumptions` ledger in `brainstorm/notes.md`, and
name `--notes-waived "<reason>"` as the recorded override.

#### Scenario: Phase doc mentions gate and waiver

- GIVEN the phase doc after this change
- WHEN an agent reads the terminal-state steps
- THEN the gate and the waiver flag are both named
