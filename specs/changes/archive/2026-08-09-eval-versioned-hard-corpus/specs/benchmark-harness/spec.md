# Benchmark Harness Delta

## ADDED Requirements

### Requirement: Evaluation corpora are explicitly versioned and allowlisted

The evaluator SHALL select corpora only through checked-in ID-to-root mappings. Omitting corpus selection SHALL retain `forgekit-held-out-v1`; filesystem paths and unknown IDs SHALL fail before execution.

#### Scenario: Operator selects the hard companion corpus
- **WHEN** the runner receives `--corpus forgekit-hard-v2`
- **THEN** it stages tasks only from that corpus's checked-in root
- **AND** plans and manifests bind its ID, manifest revision, task revision, and task version

#### Scenario: Operator omits corpus selection
- **WHEN** the runner receives no corpus selector
- **THEN** selection and staging remain `forgekit-held-out-v1`

### Requirement: Published v1 bytes are immutable

CI SHALL compare the v1 manifest and each v1 task tree to a checked-in revision lock. A mismatch SHALL fail and require a new corpus ID rather than silently rewriting v1.
