# Delta for Pace Signals

## ADDED Requirements

### Requirement: The agent decides substantiality, not the prompt filter
Whether work is substantial enough for Forge SHALL be decided by the agent,
which can read the prompt in the context of the conversation, the repository and
the session. The prompt-time filter SHALL NOT make that call. Its only role is
to **suppress** — to decide whether the agent is asked at all — and it SHALL
suppress only prompts that carry no work content: an empty prompt, an explicit
`/forge:skip`, a bare conversational reply, a read-only question, or a stated
trivial edit. Any prompt that is not suppressed SHALL reach the agent as a
request to decide, never as a verdict already reached.

#### Scenario: An ambiguous prompt reaches the agent undecided

- **GIVEN** a prompt with unclear scope that matches no suppression condition
- **WHEN** the prompt-time filter runs
- **THEN** the agent is asked to triage the prompt
- **AND** the filter does not assert that the work is substantial

#### Scenario: A conversational reply never reaches the agent as work

- **GIVEN** a bare acknowledgment such as "continue" or "thanks"
- **WHEN** the prompt-time filter runs
- **THEN** the agent is not asked to triage
- **AND** no triage reminder is emitted

#### Scenario: The triage reminder asks rather than asserts

- **GIVEN** a prompt that is not suppressed
- **WHEN** the triage reminder is produced
- **THEN** it asks the agent to decide whether the work needs Forge
- **AND** it does not state that substantial work was detected

#### Scenario: The guidance is written for a judge, not a matcher

- **GIVEN** the triage guidance the agent follows
- **WHEN** it is read
- **THEN** it presents criteria for the agent to weigh with full context
- **AND** it states that the prompt-time filter only suppresses

### Requirement: The skip gate is satisfiable
Triage SHALL treat the skip conditions as alternatives: work SHALL skip Forge
when **any** skip condition holds, not only when all of them hold. The guidance
SHALL NOT simultaneously state that a negative triage answer means direct
execution and that skipping requires explicit user opt-out.

#### Scenario: A trivial edit skips without an explicit opt-out

- **GIVEN** a prompt describing a typo fix with no behaviour change
- **WHEN** triage classifies it
- **THEN** it is not substantial work
- **AND** no `/forge:skip` from the user was required to reach that result

#### Scenario: A read-only question skips

- **GIVEN** a prompt asking how an existing command behaves
- **WHEN** triage classifies it
- **THEN** it is not substantial work

#### Scenario: Genuine work still enters Forge

- **GIVEN** a prompt asking for a new payment endpoint
- **WHEN** triage classifies it
- **THEN** it is substantial work

#### Scenario: Unclear scope still errs toward Forge

- **GIVEN** a prompt that matches no trivial marker and no clear skip condition
- **WHEN** triage classifies it
- **THEN** the agent is asked to decide rather than the prompt being dropped

### Requirement: Preset review cadence is capped at per-group
No pace preset SHALL dispatch a review after every implementer. The highest
cadence any preset SHALL configure is one review per task group. Presets SHALL
differ in review depth and fix-round count rather than in review frequency.

#### Scenario: Thorough reviews per group, not per task

- **GIVEN** the `thorough` preset
- **WHEN** its review knobs are read
- **THEN** `review.perTask` is `per-group`
- **AND** `review.depth` is `full` and `review.maxRounds` is 3

#### Scenario: Standard and thorough differ only in depth and rounds

- **GIVEN** the `standard` and `thorough` presets
- **WHEN** their review knobs are compared
- **THEN** their cadence values are equal
- **AND** their `maxRounds` values differ

### Requirement: Every preset ends with a final review
Each pace preset SHALL configure a final review for the whole change, including
the lightest presets. A preset configuring a final review SHALL allow at least
one fix round, so the review can require a change rather than only observe one.

#### Scenario: The lightest preset still reviews the whole change

- **GIVEN** the `lite` preset
- **WHEN** its review knobs are read
- **THEN** `review.final` is `always`
- **AND** `review.maxRounds` is at least 1

#### Scenario: Brisk reviews the whole change without per-task reviews

- **GIVEN** the `brisk` preset
- **WHEN** its review knobs are read
- **THEN** `review.final` is `always`
- **AND** `review.perTask` does not dispatch a reviewer for low-risk tasks

### Requirement: The high-risk floor is independent of preset cadence
Tasks touching money, authentication, shared contracts, migrations or secrets
SHALL receive an immediate per-task review at every pace, including the
lightest. Preset cadence changes SHALL NOT weaken this floor.

#### Scenario: A high-risk task is reviewed under the lightest pace

- **GIVEN** a session resolved to `lite`
- **WHEN** a task touching payment logic completes
- **THEN** an immediate per-task review is required for that task

### Requirement: Plan-time evidence resolves pace in both directions
When plan-time facts are known, pace resolution SHALL be able to lower the
resolved pace as well as raise it, using the same signals as escalation: task
count, capability count, wired spine rows and high-risk surface. A pace pinned
by the user SHALL NOT be overridden in either direction.

#### Scenario: A small clean plan lowers the resolved pace

- **GIVEN** a session auto-resolved to `standard` from unrecognized scope
- **WHEN** its plan resolves to few tasks in one capability with no wired spine
  rows and no high-risk surface
- **THEN** the resolved pace is lowered
- **AND** the session records the reason

#### Scenario: A large plan still raises the resolved pace

- **GIVEN** a session auto-resolved to `brisk`
- **WHEN** its plan resolves to at least fifteen tasks
- **THEN** the resolved pace is raised to `standard`

#### Scenario: A pinned pace survives both directions

- **GIVEN** a user-pinned pace
- **WHEN** plan-time facts would otherwise raise or lower it
- **THEN** the pinned pace is unchanged
- **AND** the session records that a pin suppressed the adjustment

### Requirement: Scoring follows the resolution rules
Session scoring SHALL treat a legitimately lowered pace as correct rather than
as a missing escalation. A session SHALL NOT be penalised for a pace adjustment
the resolution rules required.

#### Scenario: A de-escalated session is not penalised

- **GIVEN** a session whose plan-time facts lowered its pace
- **WHEN** it is scored
- **THEN** no deduction is recorded for the pace it ran at
