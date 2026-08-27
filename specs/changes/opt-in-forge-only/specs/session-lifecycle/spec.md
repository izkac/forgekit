# Delta for session-lifecycle

## ADDED Requirements

### Requirement: A Forge session starts only on explicit invocation
The agent SHALL start a Forge session only when the user invoked `/forge` or `/forge:*` (except `/forge:skip`) or asked for Forge by name in any phrasing (“use Forge”, “with Forge”, “do forge work”, “run the forge workflow”, “start a forge session”). A plain request, even one that would produce a tracked change, SHALL be executed directly without bootstrapping a session.

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

#### Scenario: Forge-by-name phrasing starts Forge

- **GIVEN** no active session
- **WHEN** the user sends `Do forge work over the add-auth openspec change`
- **THEN** `isForgeInvocation` is true
- **AND** the agent enters Forge

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

### Requirement: An invoked existing tracked change routes to the apply flow
When the user invokes Forge over a change that is already proposed (OpenSpec `openspec/changes/<name>/` or specs `specs/changes/<name>/`), the agent SHALL follow the `/forge:apply` flow: bootstrap or resume a session, set `forge phase implement` with the engine and change, and run subagent-driven implement, verify, and review. The agent SHALL NOT re-brainstorm or implement the change inline.

#### Scenario: Forge work over an existing OpenSpec change

- **GIVEN** `openspec/changes/add-auth/` exists and no active session
- **WHEN** the user sends `Do forge work over the add-auth change`
- **THEN** the agent bootstraps a session (`forge new`), sets `forge phase implement --plan-type openspec --openspec "add-auth"`
- **AND** implements via subagents with per-task review, then verify and final review

#### Scenario: /forge over an existing change routes the same way

- **GIVEN** `openspec/changes/add-auth/` exists and no active session
- **WHEN** the user sends `/forge implement the add-auth change`
- **THEN** the `/forge` command itself routes to the apply flow (session, implement phase, subagents)
- **AND** the agent does not implement the change inline in coordinator context
