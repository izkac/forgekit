# Agentic Evals

## Why

Forgekit claims to improve agentic coding by making planning, verification,
runtime wiring, and review executable rather than advisory. The repository has
session scorecards and telemetry, but no reproducible harness that compares the
same agent and model with and without Forgekit against an external outcome
oracle.

Public coding benchmarks are useful for context but are not sufficient for this
question: many measure only visible issue resolution, often use contaminated or
weakly tested tasks, and do not measure cost, false completion, test tampering,
or product-path integrity. We need a versioned, repeatable evaluation surface
that can later host private and public task sets.

## What Changes

- Add an opt-in `evals/` workspace at the repository root, outside the
  published `packages/cli` package.
- Use Harbor's native task format for containerized tasks and separate hidden
  verifier environments.
- Add a Node runner that stages one canonical task into baseline and Forge
  treatment arms, repeats trials, and invokes Harbor with the requested agent,
  model, and concurrency.
- Add a result normalizer with a stable multi-metric JSON contract. Forge
  scorecards and telemetry are recorded as secondary evidence, never treated as
  the independent outcome oracle.
- Add one Node-oriented smoke task proving functional grading, regression
  grading, and visible-test tamper measurement without exposing its verifier to
  the agent.
- Document how to add tasks, run A/B trials, and interpret results.

## Capabilities

- `benchmark-harness`: reproducible Harbor-backed A/B evaluation workspace
  (delta: `specs/benchmark-harness/spec.md`)

## Impact

- Affected areas: new `evals/` files, root developer scripts, and benchmark
  planning artifacts under `specs/changes/agentic-evals/`.
- No runtime or published-package behavior changes. Harbor and model
  credentials remain optional developer tooling.
- Evaluation runs are written under an ignored `evals/.runs/` directory and
  can be large or expensive; the documentation makes this explicit.
- The initial task is a harness smoke test, not evidence that Forgekit improves
  coding. Statistical conclusions require a larger, held-out task corpus.
