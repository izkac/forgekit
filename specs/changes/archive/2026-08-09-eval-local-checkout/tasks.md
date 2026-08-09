# Tasks

## 1. Local treatment contract

- [x] 1.1 Add CLI-level red/green coverage and implementation for mutually exclusive published/tarball selectors, missing/non-file tarballs, unsafe source names, and a local dry-run whose Forge Docker context contains only the digest-bound archive treatment. Implement single-read snapshotting/hashing, Forge-only staging, digest verification/install with lifecycle scripts disabled, and structured plan/manifest provenance without shell interpolation.

## 2. Operator and smoke path

- [x] 2.1 Update `evals/README.md` and `docs/agentic-evals.md` with exact `npm pack` commands for the current checkout, local dry/real runs, trusted-tarball warnings, digest inspection, transitive-dependency limitation, and selector rules.
- [x] 2.2 Add regression coverage for the shared deterministic-run cleanup race so evaluator tests and smoke validation can execute concurrently without deleting one another's staged arms.

## 3. Verification

- [x] 3.1 Run evaluator tests, evaluator lint, Docker-enabled smoke when host access is available, full workspace tests/lint, spec/spine/brief checks, and `git diff --check`. Record Docker/model/provider limitations honestly.
