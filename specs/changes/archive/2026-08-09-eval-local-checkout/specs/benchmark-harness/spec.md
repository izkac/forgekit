# Delta for Benchmark Harness

## ADDED Requirements

### Requirement: Provenance-bound local Forgekit treatment
The evaluator SHALL accept an explicitly selected local Forgekit tarball as an alternative to a published semantic version. It SHALL snapshot the file bytes, identify that exact archive by SHA-256, stage it only in the Forge arm, verify the digest before installation, and record treatment provenance in the run plan and every trial manifest.

#### Scenario: Local tarball is installed only in the Forge arm

- GIVEN a readable regular-file Forgekit tarball
- WHEN the runner stages both arms with the local-tarball selector
- THEN the baseline contains neither Forgekit instructions nor the local archive
- AND the Forge Docker context contains a runner-named digest-bound archive
- AND the Forge Dockerfile verifies the recorded digest before installing that archive
- AND the canonical task and verifier remain unchanged

#### Scenario: Local treatment is attributable without leaking host paths

- GIVEN a local tarball produced from a checkout that may contain uncommitted changes
- WHEN the runner emits a plan and trial manifests
- THEN each record identifies the treatment as `local-tarball`
- AND records the archive SHA-256, byte size, and staged filename
- AND does not record the operator's absolute source path
- AND does not label the local payload as a published Forgekit version

#### Scenario: Treatment selection fails closed

- GIVEN both or neither of `--forgekit-version` and `--forgekit-tarball`, an unreadable path, or a path that is not a regular file
- WHEN the runner validates the request
- THEN it rejects the request before invoking Harbor or creating a trial

## MODIFIED Requirements

### Requirement: Paired evaluation arms
The evaluator SHALL stage one canonical task into a baseline arm and a Forge arm without changing the task's starting repository. Only the Forge arm may install Forgekit or receive Forge workflow instructions. Forgekit MAY come from either a selected published version or a provenance-bound local tarball.

#### Scenario: Baseline and Forge staging differ only by treatment

- GIVEN a valid canonical task and exactly one Forgekit treatment selector
- WHEN the runner stages both arms
- THEN both staged tasks contain identical fixture files and verifier files
- AND the baseline has no Forgekit installation or package archive
- AND the Forge arm installs exactly the selected treatment
- AND each instruction identifies its arm
