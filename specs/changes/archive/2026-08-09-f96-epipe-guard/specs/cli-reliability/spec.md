# cli-reliability Specification

## ADDED Requirements

### Requirement: Forge tolerates downstream pipe closure
Forge commands SHALL exit successfully without an unhandled stack trace when stdout closes with EPIPE, while preserving other stdout failures.

#### Scenario: Consumer closes early
- **WHEN** a multi-line Forge command is piped to an early-closing consumer
- **THEN** the Forge command exits 0 without an EPIPE stack trace
