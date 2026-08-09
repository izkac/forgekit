# Built-in mutation gate retrospective

Date: 2026-08-09
Status: Experiment retired; mutation testing remains proposed through recorded
external tools.

## Outcome

The `feat/mutation-gate` branch never shipped. It reached five of nine tasks
and added 7,493 lines across a dependency-free textual mutator, process
supervision, tests, and change artifacts. No runtime or test commit from the
branch will be salvaged. The reusable output is its evidence and the
constraints below.

## Strengths

- The operator and scope work was test-driven, with positive and negative
  cases, real-repository corpus checks, and actionable file/line/operator
  attribution.
- Restoration tests covered normal, exceptional, timeout, crash, and signal
  paths and required byte-identical source restoration.
- Iterative independent review found false-mutant and safety failures before
  the gate shipped, and the work kept the weak-test-quality gap visible.

## Independently verified blockers

- A target symlink or path swap could redirect restoration and overwrite an
  unrelated file.
- Restoring the saved bytes could erase a legitimate concurrent edit made
  while the mutant was active.
- The lock and recovery-marker protocol retained a marker race, so recovery
  could act without reliable ownership of the recorded state.
- SIGINT cleanup could delete recovery artifacts it had not safely proved it
  owned.
- A stale unmutated baseline could turn an unrelated failure into a false
  mutant kill.
- Result evidence could be stale or forgeable, and a capped run could omit
  mutants while still presenting apparently successful evidence.
- A first run could fail with `ENOENT` before the lock/marker parent existed.

These are quality-gate blockers, not polish items. Fixing them would require
Forge to own a lock, backup, signal, and crash-recovery subsystem around
in-place source edits, while still leaving evidence provenance and
completeness as separate trust problems.

## Decision and future constraints

Retire the built-in in-place mutator and merge none of its runtime commits.
This rejects that implementation architecture, not mutation testing. The
external evidence for mutation-guided test hardening remains strong.

Any future R4 design must:

- use an established external mutation tool and command recorded by the
  project, never inferred or silently detected;
- prove the current unmutated baseline passes immediately before mutation;
- bind evidence to source/revision, scope, command, tool version and
  configuration, and execution time so provenance and freshness are checked;
- require complete results for the claimed scope and protect evidence from
  ordinary implementing-agent writes; and
- treat stale, partial, capped, skipped, unsupported, invalid, missing, or
  otherwise unverifiable results as uncertainty, never as a clean pass.

Mutation and restoration should be owned by the external tool or an isolated
worktree/sandbox, not by Forge editing the working source tree in place.
