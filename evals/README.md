# Agentic Evaluations

`evals/` is optional developer and research tooling for comparing the same
coding agent with and without Forgekit. Harbor runs a canonical task in two
arms:

- **baseline** uses the selected agent and model without Forgekit or injected
  Forge workflow instructions;
- **forge** uses the same task, agent, and model, installs one explicitly
  selected Forgekit treatment, and injects the Forge workflow instructions.

A separate Harbor verifier owns the hidden checks and numeric outcome reward.
Forge scorecards, `.forge/` artifacts, visible tests, and the agent's final
message are process evidence, not the outcome oracle.

For an operator walkthrough, see
[`docs/agentic-evals.md`](../docs/agentic-evals.md).

## Status And Scope

The pilot corpus is implemented in `evals/harbor/corpus.json`. It has one
small, dependency-free Node task in each of six target categories:

| Category | Task | What changes |
| --- | --- | --- |
| bug | `pagination-boundary` | Fix an exact-page pagination boundary and add a regression test. |
| feature | `node-health-endpoint` | Add `GET /health` without changing existing routes. |
| integration | `audit-log-wiring` | Wire persistence and audit adapters in the required order. |
| refactor | `router-extraction` | Extract routing and add a decoded parameter route. |
| tests | `csv-formula-regression` | Add boundary tests, then neutralize leading CSV formula markers. |
| security | `encoded-path-traversal` | Reject encoded traversal while preserving valid encoded filenames. |

Each task has an agent-visible starting repository and instructions plus its
own `tests/` verifier image. Hidden grader code is not copied or mounted into
the agent environment. "Held out" here means held out from the agent at task
execution through that separate verifier boundary. The tasks and verifiers are
in this public repository, so the corpus is not private and cannot be assumed
to be free of training contamination.

This is a **pilot corpus**, not a representative sample of coding work. Six
small Node tasks, one per category, cannot establish general effectiveness,
long-horizon behavior, or a population effect. The tools produce measurements;
they do not automatically decide whether Forgekit is effective.

## Prerequisites, Cost, And Credentials

A real model-backed run requires:

- Node.js and this repository's dependencies;
- Harbor 0.20.0 installed separately (`uv tool install harbor==0.20.0`);
- an accessible Docker daemon;
- a Harbor-supported agent and model;
- the provider credentials required by that agent/model; and
- exactly one Forgekit treatment: a published semantic version or a trusted
  local package tarball.

Real runs execute two billable model trials per repetition when `--arm both` is
used. Provider pricing, retries, model behavior, rate limits, and availability
can change. Start with one repetition and `--concurrency 1`, inspect the cost,
then scale deliberately. The runner passes credentials through the process
environment to Harbor; it does not intentionally copy credential values into
plans or manifests. Harbor, agent, and provider logs may nevertheless contain
sensitive task content, transcripts, file contents, or provider metadata.
Treat the complete run directory as sensitive.

## Validate Infrastructure Without Claiming An Effect

From the repository root:

```bash
npm run test:evals
npm run lint:evals
npm run smoke:evals
```

The smoke command checks every corpus task's metadata, arm staging, verifier
isolation, untouched fixture, known-good solution, and all three Docker build
contexts. It runs `docker build --check` when Docker is accessible, but never
invokes Harbor or a model. That Docker command validates the build context and
Dockerfile checks/lint; it does not build an image or exercise installation or
runtime behavior. The local smoke/oracle path currently invokes POSIX shell and
tooling and requires Linux, another POSIX host, or WSL rather than native
Windows semantics. The checked-in `solution/solve.sh` is a verifier oracle:
acceptance of that known-good fixture validates the grader's positive path, not
agent performance. Likewise, untouched-fixture rewards validate the
negative path only.

A Harbor `nop` trial can validate container, job, verifier, artifact, and
normalization wiring without asking an agent to solve the task. Smoke, `nop`,
and oracle/known-good runs are infrastructure evidence only. None is a coding
agent result or evidence that Forgekit helps.

## Select A Treatment Without Publishing

To evaluate this checkout, explicitly package it and pass the resulting file:

```bash
TARBALL_DIR="$(mktemp -d)"
npm pack --workspace=@izkac/forgekit --pack-destination "$TARBALL_DIR"
FORGEKIT_TARBALL="$(find "$TARBALL_DIR" -maxdepth 1 -name '*.tgz' -print -quit)"
sha256sum "$FORGEKIT_TARBALL"
```

`npm pack` runs this checkout's trusted `prepack` lifecycle. It creates a local
package; it does **not** publish. The runner never packages or publishes the
checkout and never selects it implicitly. `--forgekit-tarball` reads and
snapshots the file, records its SHA-256 and byte size without recording the
source host path, stages the digest-named bytes only in the Forge arm, verifies
the digest in the image build, and installs with lifecycle scripts disabled.
Use only a tarball you trust. Its digest identifies the payload bytes, but does
not pin registry-resolved transitive dependencies.

Alternatively, use `--forgekit-version <published-semver>`. Exactly one of
`--forgekit-tarball` and `--forgekit-version` is required even for a
baseline-only run, so the comparison cohort has an explicit treatment identity.

## Preview And Run One Task

Dry-run before spending provider tokens:

```bash
node evals/harbor/run.mjs \
  --task pagination-boundary \
  --arm both \
  --repetitions 3 \
  --concurrency 1 \
  --seed pilot-v1 \
  --agent <agent> \
  --model <model-id> \
  --forgekit-tarball "$FORGEKIT_TARBALL" \
  --dry-run
```

Remove `--dry-run` for a real run. Run the same command separately for each of
the six task ids; the runner intentionally accepts one canonical task per
invocation. `--arm baseline` and `--arm forge` are useful for diagnosis, but
one `--arm both` invocation is preferred for a paired trial. Split single-arm
runs can be temporally separated and are weaker causal evidence even when the
aggregator later matches their provenance and repetition cells.

Dry-run stages the arms, writes `plan.json` and trial manifests, and prints the
portable plan. The plan identifies the run by `runId`; combine that id with the
known runs root (`FORGEKIT_EVAL_RUNS_ROOT` or the default `evals/.runs`) to
locate it. Recorded Harbor argv uses run-relative `arms/...` and `trials/...`
locators, and Harbor executes that same argv with the run directory as its
working directory. It neither probes Harbor nor invokes a model. Deterministic
dry-runs reuse the same derived run id, so use a single writer per runs root;
concurrent writers can replace or interleave the same dry-run directory.
A real run invokes Harbor once per arm trial with Harbor's own concurrency set
to one, requires exactly one verifier-owned `reward.json`, and normalizes every
verified reward. A Harbor process exit by itself is never an outcome pass.

## Exact Seeded Pair Scheduling

For `--arm both`, one repetition is one **pair block** containing the baseline
and Forge trial for that task and repetition. The runner:

1. hashes `seed + NUL + task id + NUL + task revision` with SHA-256;
2. chooses baseline first when the first hash byte is even and Forge first when
   it is odd;
3. alternates the first arm on every subsequent repetition; and
4. executes the two trials within each pair serially in that recorded order.

The default seed is the literal `default`. A supplied `--seed` is an identifier
of at most 128 letters, digits, dots, underscores, or hyphens. The seed selects
a reproducible order; it is not passed to the model and cannot make model
outputs deterministic. An even repetition count gives equal first-position
counts. An odd count necessarily gives the hash-selected starting arm one
extra first position; `plan.json` records this imbalance, the start hash,
starting arm, every arm order, and first-arm counts.

With `--arm both`, `--concurrency N` counts active **pair blocks**, not
individual trials. Up to `N` pairs can overlap, while each pair remains serial;
a failed first arm is recorded and the second arm is still attempted. Other
pairs also continue, and the command exits nonzero after persisting all
failures. With a single arm, concurrency counts ordinary trials.

Use `--concurrency 1` for causal trials. It prevents pair blocks from
interleaving and avoids avoidable shared provider/load timing interference.
Higher pair concurrency can reduce elapsed time, but weakens causal
interpretation even though within-pair order is preserved. Concurrency one
does not eliminate model nondeterminism, provider drift, or other confounding.

## Task And Result Contracts

Each canonical task has this Harbor shape:

```text
evals/harbor/tasks/<task-id>/
  task.toml
  instruction.md
  environment/
  solution/
  tests/
```

`instruction.md` and `environment/` are agent-visible. `tests/` builds the
separate, no-network verifier and must never enter the agent image or declared
agent artifacts. `solution/` is smoke/oracle reference material and is not copied into the
task's `/app` agent environment. The verifier emits binary `functional`, `regression`,
`tests_unchanged`, and `shippable` outcomes. `tests_unchanged: 1` means the
hidden checks did not detect tampering with protected visible tests;
`shippable: 1` requires every required outcome to pass.

The runner writes `normalized-result.json` for a verified trial. The standalone
normalizer is also available:

```bash
node evals/harbor/normalize-results.mjs \
  --reward <reward.json> \
  --arm <baseline|forge> \
  --task <task-id> \
  --trial <positive-integer> \
  [--forge-summary <summary.json>] \
  [--harbor-result <trial-result.json>] \
  [--harbor-job-result <job-result.json>]
```

Verifier outcomes remain separate from optional Forge and Harbor
instrumentation. Missing telemetry is `null`/missing, never an outcome failure.
Available Harbor instrumentation includes wall-clock seconds, input/output and
cache tokens, cost, and retries.

## Aggregate Completed Runs

Pass `--run-directory` once per runner output directory; the option is
repeatable and the report is deterministic for the same persisted inputs:

```bash
node evals/harbor/aggregate-results.mjs \
  --run-directory evals/.runs/<task-run-1> \
  --run-directory evals/.runs/<task-run-2> \
  --run-directory evals/.runs/<task-run-3> \
  > aggregate.json
```

The aggregator reads terminal non-dry plans and their referenced manifests and
normalized results. It fails closed on malformed paths/files, duplicate
task/repetition arm cells, missing or inconsistent plan/manifest schedule and
Harbor provenance, or a mixed cohort. Runs must agree on agent, model, Forgekit
treatment, harness revision, corpus identity/revision, repetitions,
concurrency, and seed. Within each candidate baseline/Forge pair, task revision,
corpus provenance, category, and agent/verifier images must also match exactly.
A mismatch is an aggregation error, not an incomplete pair and not a warning.

Repeatable run directories can therefore match separate baseline and Forge
invocations only when their task/repetition cells and all cohort and per-pair
provenance align.

The primary endpoint is the **equal-task-weighted mean within-task paired delta
in `shippable`**: compute `Forge - baseline` for complete repetition pairs,
average within each task, then give each task with at least one complete pair
equal weight. This macro estimand prevents a task with more usable repetitions
from dominating the primary result.

Pooled arm rates and pooled paired deltas under `arms` and `pairs` are
**micro, descriptive metrics**. Per-task and per-category summaries and
available-pair cost/time/token/retry deltas are descriptive diagnostics, not
substitutes for the primary estimand.

A complete pair has verified outcomes for both arms of the same task and
repetition. If either arm fails operationally or lacks a verified normalized
outcome, the pair is listed under `incomplete_pairs` and excluded from paired
deltas. Operational failures and missing instrumentation are **missing, not
zero**: they must not be converted into unsuccessful outcomes or free/instant
runs. Report complete/incomplete counts and missingness alongside every result.

Aggregation computes summaries only. It performs no hypothesis test, power
analysis, uncertainty estimate, practical-significance threshold, or automatic
"ship"/effectiveness verdict.

## Live Progress

Real runs keep stdout as one final JSON plan and write sanitized `[eval-progress]`
lifecycle messages to stderr. A heartbeat appears every 30 seconds by default so
long Harbor setup or model work does not look hung. Set
`--progress-interval-seconds N` (0–86400) to change the cadence or `0` to disable only
periodic heartbeats. Messages include safe run/trial/task ids, arm, status, ordinal,
trial/outcome counts, and elapsed seconds; they exclude prompts, credentials, and paths.

## Provenance, Reproducibility, And Privacy

Every run persists `evals/.runs/<run-id>/plan.json` plus one
`trials/<trial-id>/manifest.json` per trial. The plan records corpus identity
and revision, task/category and task revision, harness revision, selected seed
and exact schedule, images, agent/model, treatment identity, settings, arm
staging, trial order/status, and timestamps. Each manifest binds a trial to the
same provenance and records planned versus actual execution order, Harbor argv/version with the
exact run-relative locators used for execution, requested and resolved agent
information when available, reward
and result references, status, errors, and normalized-result references.
Plans and manifests are written before execution and updated during/after it,
so partial and failed runs remain auditable.

For fair comparisons, hold the task revision, agent, model and model settings,
treatment, seed, repetition count, concurrency, images, and provider setup
constant. Repeat paired observations; do not pool unmatched cohorts. Record and
report provider/model drift and unpinned dependencies as limitations.

Run directories are ignored by Git and excluded from the published package,
but that is not a privacy guarantee. Stdout plans, persisted plans, and
manifests use portable relative task/artifact/staging locators and omit the
absolute run directory. `runId` is the stable locator: the operator combines it
with the configured runs root (or the default `evals/.runs`). Harbor is invoked
from that run root with the exact relative argv recorded in provenance.

Forge artifact summaries and normalized telemetry use a trial-Harbor-output-relative
`artifactLocator` plus relative file names. Resolve the locator beneath
`$RUN_DIR/trials/<trial-id>/harbor`; the host-absolute discovery path is not
serialized. Raw artifacts and logs may still contain host paths, source,
hidden-verifier output, model transcripts, Forge telemetry, and provider
metadata. The local tarball's source host path is deliberately omitted, and
credential values are not intended to be recorded, but operators must inspect
and redact a run before sharing or archiving it. Never commit run artifacts or
put secrets in tasks, instructions, model identifiers, agent identifiers, or
seeds.

## Interpretation Limits

Report the exact pilot corpus, task-level results, complete and incomplete
pairs, missing metrics, cost, time, treatment digest/version, and all cohort
controls. Do not generalize from these six tasks to other languages,
repositories, models, providers, long-running changes, or production work.
Public benchmark results can be useful context, but do not remove contamination,
representativeness, verifier-quality, or nondeterminism concerns. Any causal or
product claim requires a preregistered analysis, adequate repetitions and
power, uncertainty reporting, robustness checks, and additional private or
independently maintained held-out tasks.
