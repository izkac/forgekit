# Delta for Brainstorm Interview

## ADDED Requirements

### Requirement: Frontier-round interviewing

The brainstorming skill SHALL instruct the agent to model the design as a decision
tree and interview in rounds: each round asks every question whose prerequisites are
settled (the frontier), numbered, and a question depending on an answer still open in
the current round SHALL be deferred to a later round.

#### Scenario: Independent questions batch into one round

- GIVEN a brainstorm with three open questions where none depends on another
- WHEN the agent asks the user
- THEN all three appear in a single round as numbered questions, each with a
  recommended answer

#### Scenario: Dependent question waits

- GIVEN question B's answer depends on question A, still unanswered
- WHEN the agent composes a round
- THEN B is absent from the round containing A and appears in a later round

### Requirement: Facts are never asked of the user

The skill SHALL instruct the agent to answer fact questions (codebase, docs,
environment) itself — directly or via a non-blocking exploration subagent — and put
only decisions to the user.

#### Scenario: Codebase fact resolved by exploration

- GIVEN a frontier question answerable by reading the repository
- WHEN the round is composed
- THEN that question is not asked of the user, and only its downstream questions
  wait for the exploration result

### Requirement: Recommended answers with a fast path

Every question put to the user SHALL carry a recommended answer, and the first round
SHALL tell the user they may reply "all recommended" or answer selectively.

#### Scenario: User accepts a round wholesale

- GIVEN a round of questions each bearing a recommendation
- WHEN the user replies "all recommended"
- THEN the agent treats every recommendation in that round as the user's answer and
  recomputes the frontier

### Requirement: Assumption ledger and termination

The skill SHALL require an open-questions/assumptions ledger maintained in the
session brainstorm notes; the interview ends only when the frontier is empty and
every ledger entry is either answered or promoted to an explicit assumption. The
design doc SHALL contain an Assumptions section, and the spec self-review SHALL
include a check that no default is in play outside that section.

#### Scenario: Silent default surfaced at termination

- GIVEN the frontier is empty but a default was adopted without being asked
- WHEN the agent closes the interview
- THEN the default appears in the design doc's Assumptions section presented for
  user review

### Requirement: Pace-scaled interview depth

`brainstorm.depth` SHALL scale the interview: `full` runs rounds until the frontier
is empty; `short` caps at about two rounds and folds remaining branches into
recommended-answer assumptions; `minimal` asks at most one intent-confirming round.

#### Scenario: Short pace folds open branches

- GIVEN `brainstorm.depth: short` and open branches after two rounds
- WHEN the agent presents the design
- THEN the unasked branches appear as recommended-answer entries in the Assumptions
  section rather than as further rounds
