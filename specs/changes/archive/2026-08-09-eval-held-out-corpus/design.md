# Design

## Corpus

`evals/harbor/corpus.json` is the versioned catalog. It contains exactly one task for each initial category: bug, feature, integration, refactor, tests, and security. Every task remains a self-contained Harbor directory with a separate verifier image. The agent image never receives grader sources. Visible regression tests are hashed before execution; added-test requirements prevent production-only shortcuts. Repository solutions exist only for local oracle validation.

The corpus is held out at execution through Harbor's separate verifier boundary, not claimed to be private or contamination-free after publication. Initial tasks are coverage, not a statistically representative population.

## Scheduling

For `--arm both`, the runner records a seed and hashes it with the canonical task identity to choose the first arm. Repetition order alternates from that start, producing exact counterbalance for even repetition counts and an explicit one-trial imbalance for odd counts. Trial manifests record schedule position and within-pair position. Concurrency may overlap scheduled trials; causal runs should use concurrency one.

## Aggregation

A standalone aggregator reads normalized results and their manifests from one or more run directories. It verifies one coherent cohort (agent, model, treatment, harness and scheduling controls), rejects duplicate task/repetition/arm cells, and reports incomplete pairs explicitly. Outcomes are summarized per arm, category, and task; paired deltas and win/loss/tie counts use only complete pairs. Cost/time/token deltas use only pairs where both values exist and report missing counts. Output carries limitations and never labels Forge effective automatically.

## Reproducibility and failure behavior

The runner writes `plan.json` into the run directory as well as stdout. Seed, task/category, revisions, treatment digest, Harbor version, and exact schedule are committed to plans/manifests. Invalid manifests, unknown corpus tasks, mixed cohorts, duplicate cells, malformed normalized records, or missing provenance fail closed before an aggregate is emitted.
