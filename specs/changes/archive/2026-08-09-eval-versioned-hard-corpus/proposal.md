# Change: Versioned hard evaluation corpus foundation

## Why

The frozen `forgekit-held-out-v1` corpus is useful for evaluator integrity but its six small tasks do not discriminate capable provider arms: the first authenticated Luna pair tied on the easiest bug task. Scaling repetitions would spend budget without addressing task difficulty. The evaluator also assumes one fixed manifest/root, so changing v1 in place would invalidate its existing results.

## What changes

- Freeze v1 bytes and revisions and keep it as the default corpus.
- Add an explicit allowlisted `--corpus` selector with complete selected-corpus provenance.
- Introduce a separate `forgekit-hard-v2` companion root without changing v1 weighting or history.
- Deliver `reservation-confirmation-race` as the first hard, cross-module concurrency exemplar with deterministic barrier probes, semantic mutants, and two distinct correct implementations.
- Generalize task metadata only where required for multiple visible tests/entrypoints.

The other five designed v2 categories will land as independent reviewed slices before v2 is declared complete or used for effectiveness claims.

## Impact

Evaluation harness and public benchmark fixtures only. No package publication, provider call, or mutation of prior run artifacts. The omitted selector remains v1-compatible.
