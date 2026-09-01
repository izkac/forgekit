# Brainstorm Interview Spec

## Purpose

Describe this capability.

## Requirements

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

### Requirement: Spike classification before the interview
The brainstorming skill SHALL instruct the agent to classify a request whose core
open question is feasibility as a **spike** before starting the frontier-round
interview: a time-boxed throwaway investigation whose output is a recommendation,
with any code clearly labeled throwaway, and no spec or design doc produced. Spike
approval SHALL never be treated as approval to implement; follow-up work restarts
brainstorm with the spike's findings.

#### Scenario: Feasibility question becomes a spike

- GIVEN a request like "can our importer handle 1M-row files?"
- WHEN brainstorm starts
- THEN the agent proposes a spike (question, time box, method) instead of opening
  the design interview, and ends with a recommendation rather than a spec

#### Scenario: Spike does not authorize implementation

- GIVEN a completed spike whose recommendation is "feasible via streaming parse"
- WHEN the user says "great"
- THEN the agent does not begin implementing; a real change starts its own
  brainstorm using the spike findings

### Requirement: Questionnaire escape hatch for absent knowledge
The skill SHALL instruct the agent, when a frontier question can only be answered
by someone not in the session, to mark that branch blocked in the ledger, write a
hand-off questionnaire to `questionnaire-<slug>.md` in the repo root (purpose,
recipient, one context paragraph, gap-targeted questions most-important-first with
answer stubs), and continue interviewing the rest of the frontier. A blocked branch
SHALL resolve only from returned answers or by promotion to an explicit Assumption
with the user's consent.

#### Scenario: Stakeholder-only question does not stall the interview

- GIVEN a frontier question only the billing team can answer
- WHEN the round is composed
- THEN that branch is marked blocked, a questionnaire file is written and named to
  the user, and the remaining frontier questions are still asked now

### Requirement: Scenario red-team in spec self-review
The spec self-review SHALL include a sixth check: invent two to three concrete
edge-case scenarios probing the design's boundaries and verify the design answers
each; a scenario the design cannot answer SHALL become an open question to the
user or an explicit Assumption, never be silently dropped.

#### Scenario: Unanswerable edge case surfaces

- GIVEN a design for CSV import and the invented scenario "two concurrent imports
  of the same file"
- WHEN the self-review runs and the design has no answer
- THEN the agent raises it to the user as an open question (or records an explicit
  Assumption) before requesting spec approval

### Requirement: Domain pass against the project glossary
When the repo contains a `CONTEXT.md`, the skill SHALL instruct the agent to
challenge interview terms that conflict with the glossary and to propose precise
canonical terms for fuzzy or overloaded ones. When writing `decisions.md`, entries
passing the ADR triple test — hard to reverse AND surprising without context AND
the result of a real trade-off — SHALL be prefixed `ADR-candidate:` so ADR-enabled
projects pick them up at archive time. Absent `CONTEXT.md`, the glossary pass is
silent.

#### Scenario: Glossary conflict is challenged

- GIVEN `CONTEXT.md` defines "cancellation" as voiding a whole Order
- WHEN the user describes partial cancellation in the interview
- THEN the agent surfaces the conflict and asks which meaning holds

#### Scenario: ADR-worthy decision is marked

- GIVEN a decision to adopt event sourcing over CRUD after weighing both
- WHEN decisions.md is written
- THEN that entry carries the `ADR-candidate:` prefix, and a trivially reversible
  choice does not

### Requirement: Spike terminal state in the phase doc
The brainstorm phase doc SHALL state that a spike ends by reporting the
recommendation and running `forge phase skipped --exit-reason "spike: <question>"`,
bypassing the plan pipeline.

#### Scenario: Spike session closes without a plan

- GIVEN a session whose brainstorm classified the work as a spike
- WHEN the spike report is delivered
- THEN the session is marked skipped with a spike exit reason and no change
  directory is scaffolded
