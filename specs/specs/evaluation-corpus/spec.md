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
