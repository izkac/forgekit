# Delta for session-lifecycle

## ADDED Requirements

### Requirement: A Forge session starts only on explicit invocation
The agent SHALL start a Forge session only when the user invoked `/forge` or `/forge:*` (except `/forge:skip`) or asked in natural language to use Forge (“use Forge”, “using Forge”, “use the Forge …”). A plain request, even one that would produce a tracked change, SHALL be executed directly without bootstrapping a session.

`isForgeInvocation` SHALL return true for those invoke forms and false for a plain implementation request, a read-only question about Forge, and the word `forgekit`.

When a Forge session is already active, follow-ups on that work MAY continue the session without a second invoke. An unrelated request without an invoke SHALL NOT start a new session.

#### Scenario: Slash command starts Forge

- **GIVEN** no active session
- **WHEN** the user sends `/forge add rate limiting`
- **THEN** the agent enters Forge (triage first, then `forge new` if the work is substantial)

#### Scenario: Natural language starts Forge

- **GIVEN** no active session
- **WHEN** the user sends `Use Forge. Add rate limiting.`
- **THEN** `isForgeInvocation` is true
- **AND** the agent enters Forge (triage first)

#### Scenario: Plain work does not start Forge

- **GIVEN** no active session
- **WHEN** the user sends `Add rate limiting to the public API.`
- **THEN** `isForgeInvocation` is false
- **AND** the agent does not bootstrap a Forge session

### Requirement: Triage is the first step after invoke
After an invoke, the agent SHALL still triage before brainstorm or plan: substantial work continues the Forge pipeline; trivial, read-only, or `/forge:skip` work executes directly. Invocation does not skip triage.

#### Scenario: Invoked typo may skip the pipeline

- **GIVEN** the user sent `/forge fix the typo in README`
- **WHEN** triage runs
- **THEN** the agent may execute directly without brainstorm/plan
- **AND** it does not skip the triage step itself
