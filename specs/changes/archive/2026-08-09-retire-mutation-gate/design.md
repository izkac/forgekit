# Design - retire the built-in mutation gate experiment

## Decisions

### D1 - preserve conclusions, not coupled code

The useful operator, scope, and restoration tests are coupled to a 2,700-line
home-grown mutator/process supervisor. Cherry-picking them without the runtime
creates dead tests; cherry-picking the runtime creates an unsupported and
unsafe API. The reusable asset is therefore the measured evidence and the
acceptance constraints it produced.

### D2 - keep mutation testing on the roadmap

The external evidence for mutation-guided test hardening remains strong. The
failed experiment rejects one implementation architecture, not the objective.
R4 remains proposed through project-recorded external tools such as StrykerJS,
mutmut, PIT, or cargo-mutants.

### D3 - future evidence must be fail-closed about uncertainty

A future gate must first prove the unmutated baseline passes, bind results to
source, command, tool, and revision identity, protect evidence from ordinary
agent writes, and distinguish complete results from stale, capped, skipped,
unsupported, or invalid runs. None of those states may read as a clean pass.

### D4 - no in-place source mutation owned by Forge

Forge should not maintain a global lock, backup, signal, and crash-recovery
protocol for temporary source edits. Mutation execution and restoration belong
to established tools or isolated worktrees/sandboxes whose safety contract is
independent of Forge's session bookkeeping.

## Finding disposition

- Resolve F97-F102 as obsolete with the unmerged branch.
- Keep F95 open: checkpointing silently no-ops on the default branch.
- Keep F96 open: `forge prefs` has an EPIPE failure.
- Do not add branch-review findings to the global queue; the implementation
  they describe is being deleted, and the retrospective records the reusable
  constraints.
