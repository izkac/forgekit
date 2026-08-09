# Checkpoint Safety Spec

## Purpose

Describe this capability.

## Requirements

### Requirement: Session creation exposes configured but unavailable checkpoints
When checkpoint mode is `per-group` or `per-task` and the current branch is `main` or `master`, `forge new` SHALL warn that checkpoints will be refused unless `git.allowDefaultBranch` is true.

#### Scenario: Protected default branch
- **WHEN** a session is created on a protected default branch with checkpoints enabled and no explicit allowance
- **THEN** creation succeeds and both JSON output and stderr carry an actionable checkpoint warning

#### Scenario: Checkpoints are eligible or disabled
- **WHEN** checkpointing is off, the branch is not protected, or explicit default-branch allowance is true
- **THEN** session creation emits no checkpoint warning
