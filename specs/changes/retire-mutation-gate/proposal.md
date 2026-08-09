# Retire the built-in mutation gate experiment

## Why

The parked `feat/mutation-gate` branch explored a dependency-free textual
mutator that edited source files in place. Independent review found that the
approach could lose concurrent edits, defeat its own crash recovery, trust
stale or forgeable evidence, and overwrite unrelated files after a target-path
swap. Those failures are incompatible with a quality gate.

The branch has never shipped, so the safe decision is to retain the evidence
and discard the implementation rather than let sunk cost justify an unsafe
runtime surface.

## What Changes

- Record a concise retrospective covering what worked, what failed, and what a
  future mutation integration must prove.
- Keep roadmap item R4, but constrain it to project-recorded external mutation
  tools and fresh, complete, protected evidence.
- Update predecessor documentation that described R4 as an undifferentiated
  follow-up.
- Resolve findings F97-F102 because their subject code will not exist on
  `main`; keep F95 and F96 open because they describe shipped Forge behavior.
- Merge no runtime or test commit from `feat/mutation-gate`, then delete the
  local branch after verification.

## Impact

No runtime behavior or public command changes. The weak-test-quality gap
remains open, explicitly, until a fresh R4 design is approved.
