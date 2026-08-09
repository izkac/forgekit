# Evaluation Corpus Delta

## ADDED Requirements

### Requirement: Hard tasks exercise cross-module state invariants

The hard companion corpus SHALL use realistic multi-module tasks whose hidden behavior requires more than a local one-line edit. The reservation exemplar SHALL deterministically exercise overlapping confirmations, idempotent replay/conflict, payment failure recovery, expiry precedence, and unrelated-reservation progress.

#### Scenario: Two confirmations overlap
- **WHEN** verifier-owned barriers overlap confirmation attempts for one reservation
- **THEN** exactly one charge and terminal confirmation occur
- **AND** all commands observe the documented stable or conflict outcome

### Requirement: Grading is solution-independent and deterministic

Hidden verification SHALL use documented runtime seams, manual clocks, fixed IDs, and deferred barriers rather than source matching or timing sleeps. Both the reference solution and an internally distinct correct implementation SHALL pass.

### Requirement: Added-test evidence kills semantic mutants

Where a task requests added tests, the grader SHALL run those tests against complete, API-compatible semantic mutants and count only assertion failures as kills. Import, syntax, bootstrap, and timeout failures SHALL NOT qualify.
