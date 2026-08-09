# Design

## Context

Forgekit targets command-line coding agents and already records process
artifacts under `.forge/`. The benchmark must preserve the agent's normal
filesystem interaction while keeping the functional and quality oracle outside
its control. Harbor supplies the container/task/trial abstraction, local task
datasets, supported CLI agents, and separate verifier environments.

## Decisions

- Decision: keep benchmark code in `evals/`.
  - Alternatives considered: add a `packages/evals` workspace or publish a
    second npm package.
  - Rationale: the harness is developer/research tooling, not a Forge runtime
    consumer. A root directory avoids publishing Harbor-specific code and
    keeps task fixtures close to the Forgekit version they measure.
- Decision: use Harbor's native task format rather than reimplementing a
  container runner.
  - Alternatives considered: Inspect AI as the primary runner; a bespoke
    Node/Docker runner; direct SWE-bench harness integration.
  - Rationale: Harbor supports the agent CLIs Forgekit targets, local datasets,
    repeated trials, and isolated verifier containers. Inspect AI remains a
    compatible future alternative for richer Python scoring. SWE-bench remains
    a supplemental task source, not the Forge-specific harness.
- Decision: stage arms from one canonical task directory.
  - Alternatives considered: maintain separate baseline and Forge task trees;
    inject a prompt at the host outside Harbor.
  - Rationale: copying and applying a small, validated treatment transform
    prevents task drift and makes the experimental difference visible in a
    run manifest. The agent still receives the same repository and task body.
- Decision: grade in a separate Harbor verifier environment.
  - Alternatives considered: visible tests in the agent container; an LLM
    judge; post-hoc inspection of the agent's claim.
  - Rationale: hidden functional checks, regression checks, and tamper checks
    must not be writable by the implementation agent. Numeric rewards make
    aggregation deterministic and leave human review as a secondary measure.
- Decision: make the runner a thin Node CLI with no new runtime dependency.
  - Alternatives considered: add Python/Harbor as a monorepo dependency.
  - Rationale: Harbor is installed separately with `uv`; Forgekit's package
    remains Node-only. The runner only stages tasks, invokes the Harbor CLI,
    and normalizes result artifacts.

## Risks / Trade-offs

- Harbor and model execution are external and may be unavailable in CI; unit
  tests therefore validate staging and normalization without invoking Harbor.
- Installing the published Forgekit package in a treatment image measures the
  shipped package, while local dogfooding needs a future tarball option. The
  runner records the selected package version so the distinction is explicit.
- Forge's planning ceremony can be harmful on trivial tasks. The task schema
  records category and difficulty, and the eventual corpus must include both
  triage-eligible small tasks and substantial changes.
- A single smoke task cannot establish an effect size. The README defines it as
  a wiring check and requires paired repetitions plus held-out tasks for claims.
