# Design

## Context

The existing hard-v2 reservation task establishes the isolation and grading pattern: a public agent fixture, protected visible tests, a separate no-network verifier, candidate execution under an untrusted UID, deterministic hidden probes, semantic-mutant qualification of agent-added tests, and two structurally different correct implementations. The hard-v2 smoke already iterates manifest entries, but its host-suite registry and required mutant path are reservation-specific.

The tranche must broaden task mechanisms without changing v1, provider execution, paired aggregation, or the four binary reward fields.

## Decisions

### Three distinct vertical slices

Add Security, Tests, and Integration now. Each slice owns its seed repository, instruction, metadata, verifier, semantic mutants, oracle, alternate positive, task-specific host evidence, manifest entry, and documentation. Review each slice independently before the final corpus review.

Alternatives considered:

- Adding all five remaining categories creates a larger batch and delays feedback on verifier generality.
- Repeating reservation first spends provider budget without increasing task diversity.

### Security contract: tenant-bound capabilities

`tenant-signed-downloads` uses a manual clock, fixed tenant keys, colliding document IDs, an injected tenant document store, and a real local HTTP boundary. A valid capability canonically binds tenant ID, document ID, and integer expiry. Authenticated tenant, route tenant, capability, and storage lookup must agree. Expiry rejects at `now >= expiresAt`; malformed values and signatures fail closed without throwing or returning bytes.

The semantic mutant is a complete compatible implementation that omits tenant identity from the signed payload. Hidden checks grade observable responses and bytes, not source patterns or timing.

### Tests contract: cumulative ledger invariants

`partial-refund-ledger-invariants` uses integer cents, an append-only refund ledger, a recording refund gateway, and a local HTTP boundary. Successful entries cumulatively cannot exceed the charge. Failed or rejected attempts do not consume balance. Exact remainder is allowed. Idempotent replay has no duplicate gateway or ledger effect; conflicting key reuse fails before effects.

The requested agent-added test is table-driven boundary coverage in a new protected-independent test file. Its semantic mutant uses only the latest successful ledger entry when computing refundable balance. Hidden checks observe responses, ledger entries, gateway calls, and assertion-qualified mutant kills.

### Integration contract: carrier-scoped reconciliation

`carrier-event-reconciliation` uses configured carrier normalizers, an append-only event store, a shipment projection store, and a local HTTP boundary. Deduplication identity is `(carrier, eventId)`. An accepted normalized event is appended exactly once before projection. Duplicates have no repeated effects. Older events remain recorded but cannot regress a newer projection, and delivered is terminal against late non-terminal events. Unknown carriers and malformed events fail before writes.

The semantic mutant deduplicates on bare event ID and projects arrival order. Hidden checks use fixed event sequences and recording adapters; no wall-clock ordering or external network.

### Preserve the verifier boundary

Each verifier remains self-contained inside its task because Harbor builds the task-local `tests/` directory as a separate context. Hidden code is never copied or mounted into the agent environment. Candidate-controlled modules run as UID/GID 65534; verifier sources and trusted snapshots stay root-owned. Added-test qualification accepts only registered assertion failures against complete API-compatible mutants, never crashes, syntax failures, bootstrap failures, or timeouts.

### Generalize smoke narrowly

Keep an explicit checked-in task-to-host-suite registry. Replace the single hard-coded reservation mutant requirement with manifest/task-local validation that each selected task contains its declared task-specific semantic mutant evidence. The smoke validates every manifest entry, both staged arms, verifier isolation, the six required host paths, and exactly three Docker contexts per task. It never invokes Harbor or a model.

### Calibration is a later operator action

Implementation produces no provider-backed result. Documentation will distinguish one paired repetition from exact counterbalancing. A preregistered seed, treatment artifact, concurrency one, and stop/spend rule are fixed before execution. Two repetitions are required for exact within-task first-position balance. Any substantive task edit after calibration bumps the task version and invalidates that calibration for effectiveness analysis.

## Risks / Trade-offs

- Public tasks are contamination-prone. Separate hidden execution reduces leakage at runtime but does not make the public corpus private.
- Four Node 22 backend tasks are still not representative of languages, repositories, or long-horizon work. Documentation continues to call hard-v2 incomplete.
- Security behavior must fail closed without relying on timing assertions; constant-time implementation details are not directly graded.
- Financial and reconciliation fixtures could accidentally become concurrency tasks. Their hidden probes remain deterministic sequential state/effect checks so each category has a distinct dominant failure mode.
- Task-local isolation repeats some verifier supervision code. Sharing it outside the Docker context would weaken the existing boundary; correctness and self-contained contexts take precedence over deduplication.
