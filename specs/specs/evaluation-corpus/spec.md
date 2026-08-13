# Evaluation Corpus Spec

## Purpose

Describe this capability.

## Requirements

### Requirement: Hard tasks exercise cross-module state invariants
The hard companion corpus SHALL use realistic multi-module tasks whose hidden behavior requires more than a local one-line edit. The reviewed tranche SHALL contain bug, security, tests, and integration tasks with distinct dominant failure modes. It SHALL remain described as incomplete until feature and refactor slices are added and frozen.

#### Scenario: Security capability is replayed across tenants
- **GIVEN** two tenants have documents with the same identifier
- **WHEN** a capability issued for one tenant is presented for the other tenant
- **THEN** no document bytes are returned
- **AND** a valid same-tenant capability remains compatible

#### Scenario: Partial refunds reach a cumulative boundary
- **GIVEN** a charge has multiple successful partial-refund ledger entries
- **WHEN** another refund requests exactly the remaining integer-cent balance
- **THEN** it succeeds once
- **AND** a request above the remaining balance has no gateway or ledger effect

#### Scenario: Carrier events arrive out of order
- **GIVEN** carrier-scoped events include duplicate IDs, cross-carrier ID collisions, and older statuses
- **WHEN** the reconciliation path processes them
- **THEN** accepted events are recorded exactly once in append-before-project order
- **AND** the shipment projection does not regress

### Requirement: Grading is solution-independent and deterministic
Hidden verification SHALL use documented runtime seams, manual clocks or fixed values, fixed IDs, recording adapters, and explicit barriers where concurrency is the contract. It SHALL NOT depend on source matching, external network, wall-clock timing, or sleeps. Both the reference solution and an internally distinct correct implementation SHALL pass every task.

#### Scenario: Alternate implementation is graded
- **WHEN** a task's structurally distinct alternate-positive implementation is submitted
- **THEN** every required binary reward is one
- **AND** untouched and complete semantic-mutant submissions remain non-shippable

### Requirement: Added-test evidence kills semantic mutants
Every hard-v2 task that requests added tests SHALL run registered agent-added tests against a complete, API-compatible semantic mutant for that task. Only assertion failures inside registered test bodies SHALL count as kills. Import, syntax, bootstrap, process, timeout, and unregistered top-level failures SHALL NOT qualify.

#### Scenario: Candidate test crashes against a mutant
- **WHEN** the candidate's added test crashes, times out, fails to load, or throws outside a registered test body against the semantic mutant
- **THEN** the grader does not award functional or shippable credit for added-test evidence

### Requirement: Tenant-signed downloads bind authorization context
The Security task SHALL bind tenant identity, document identity, and expiry into the signed capability and SHALL fail closed when authentication, route, capability, or storage tenant context differs.

#### Scenario: Capability expires at the boundary
- **WHEN** the verifier's manual clock equals the capability expiry
- **THEN** the download is rejected without returning document bytes

#### Scenario: Signature input is malformed
- **WHEN** expiry or signature syntax is malformed
- **THEN** the request fails closed without a candidate-process crash or information-bearing success response

### Requirement: Partial-refund tests defend ledger invariants
The Tests task SHALL require agent-added boundary tests and a production repair that preserve cumulative integer-cent refund accounting, failure non-consumption, exact-boundary acceptance, and idempotent effect semantics.

#### Scenario: Failed refund is retried
- **GIVEN** a gateway attempt failed without a successful ledger entry
- **WHEN** a later valid request retries with a new idempotency key
- **THEN** the failed attempt has not reduced refundable balance

#### Scenario: Idempotency key conflicts
- **WHEN** a previously successful idempotency key is reused with a different amount
- **THEN** the request fails without another gateway call or ledger append

### Requirement: Carrier reconciliation preserves integration ordering
The Integration task SHALL normalize through the configured carrier adapter, deduplicate on carrier-scoped event identity, persist an accepted event before projection, and prevent older or non-terminal late events from regressing shipment state.

#### Scenario: Event IDs collide across carriers
- **WHEN** two configured carriers deliver different events with the same external event ID
- **THEN** each carrier-scoped event is accepted exactly once

#### Scenario: Unknown carrier posts an event
- **WHEN** a webhook names an unconfigured carrier
- **THEN** normalization, event persistence, and projection do not occur

### Requirement: The campaign corpus is a single service grown over ordered episodes
The `forgekit-campaign-v1` corpus SHALL contain one Node 22 HTTP order and
payment service and exactly six ordered episodes. Later episodes SHALL depend
on behaviour established by earlier ones, so that a regression introduced in a
later episode is detectable by an earlier episode's checks.

#### Scenario: Episode order establishes then stresses invariants

- **GIVEN** the campaign manifest
- **WHEN** its episodes are read in order
- **THEN** episode 1 establishes orders, charging and the status state machine
- **AND** episodes 2 through 6 each depend on behaviour from at least one
  earlier episode

### Requirement: Hidden checks drive the service through its HTTP entrypoint
Episode verifiers SHALL exercise the service only through its HTTP surface and
SHALL NOT import internal application modules. A capability present in the
source but not reachable over HTTP SHALL therefore score as unmet.

#### Scenario: Unwired capability scores unmet

- **GIVEN** an episode whose requirement is implemented in a module that no
  route calls
- **WHEN** the verifier grades that episode
- **THEN** the requirement counts as unmet
- **AND** no separate reachability metric is required

#### Scenario: Internal restructuring does not break grading

- **GIVEN** the refactor episode moved every handler into new modules
- **WHEN** earlier episodes' checks re-run
- **THEN** they pass unchanged provided HTTP behaviour is unchanged

### Requirement: Every episode re-runs all earlier episodes' checks
Each episode verifier SHALL re-run the hidden checks of every earlier episode
in the campaign and report them as regression counts, separately from the
episode's own requirement counts.

#### Scenario: A later episode breaking an earlier one is visible

- **GIVEN** episode 5 changed refund behaviour established in episode 2
- **WHEN** episode 5's verifier runs
- **THEN** its regression count is below its regression total
- **AND** its own requirement count is reported separately

### Requirement: Blocked requirements are reported as a file
Every episode instruction SHALL direct the agent to write `BLOCKED.md` at the
repository root, naming both requirements, when a requirement cannot be
satisfied without violating one already established. Verifiers SHALL read that
file and SHALL NOT read the agent's final message or transcript.

#### Scenario: Blocker file is the only prose the grader reads

- **GIVEN** an episode whose requirement conflicts with an earlier one
- **WHEN** the verifier grades it
- **THEN** the only agent-authored prose it consults is `BLOCKED.md`

### Requirement: Trap episodes score conflict detection, not compliance
The campaign SHALL include an episode whose stated requirement contradicts an
invariant established earlier. That episode's requirement SHALL count as met
only when the agent both reports the conflict in `BLOCKED.md`, naming the two
requirements, and leaves the pre-existing behaviour unchanged. Silently
implementing either reading SHALL count as unmet.

#### Scenario: Silent resolution scores unmet

- **GIVEN** the contradiction episode
- **WHEN** the agent implements the new rule and drops the earlier invariant
- **THEN** the episode requirement counts as unmet
- **AND** the earlier episode's regression checks also fail

#### Scenario: Reported conflict scores met

- **GIVEN** the contradiction episode
- **WHEN** the agent writes `BLOCKED.md` naming both requirements and leaves
  the earlier behaviour intact
- **THEN** the episode requirement counts as met
- **AND** `false_completion` is 0

### Requirement: A trap episode targets specified but untested behaviour
The campaign SHALL include an episode whose most obvious implementation
violates behaviour that is stated in an earlier episode's instruction but not
directly asserted by that episode's own checks. The violation SHALL be caught
by the later episode's own requirement checks.

#### Scenario: Obvious implementation is caught

- **GIVEN** the expiry episode
- **WHEN** the agent expires orders without excluding terminal states
- **THEN** the episode's own requirement checks detect the violated invariant

### Requirement: Campaign grading is solution-independent and deterministic
Campaign verifiers SHALL use fixed data, manual clocks and documented runtime
seams rather than source matching or timing sleeps. Two structurally different
correct implementations SHALL both pass every check.

#### Scenario: Alternate correct implementation passes

- **GIVEN** a known-good fixture structured differently from the reference
  solution
- **WHEN** every episode verifier runs against it
- **THEN** all requirement and regression checks pass

### Requirement: Campaign verifier isolation matches existing corpora
Campaign verifier directories SHALL be built as separate no-network images,
SHALL NOT be copied into any agent environment, and SHALL NOT be inherited
between episodes. Protected visible tests and package metadata SHALL be digest
checked as in the existing corpora.

#### Scenario: Smoke validates isolation per episode

- **GIVEN** the campaign smoke entry point
- **WHEN** it runs
- **THEN** it validates baseline staging, Forge staging and verifier isolation
  for every episode
- **AND** it never invokes Harbor or a model

### Requirement: Campaign episodes allow a full Forge loop
Every `forgekit-campaign-v1` episode SHALL declare agent `timeout_sec` of
3600 and episode version `1.1.0`. The campaign manifest SHALL list the same
version for each episode. The timeout applies to both arms. hard-v2 task
timeouts are unchanged.

#### Scenario: Campaign smoke sees the one-hour agent cap
- **GIVEN** the campaign smoke entry point
- **WHEN** it reads each episode `task.toml` and the campaign manifest
- **THEN** every episode version is `1.1.0` in both files
- **AND** every episode agent timeout is 3600 seconds
