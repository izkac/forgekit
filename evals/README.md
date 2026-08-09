# Agentic Evaluations

`evals/` is optional developer and research tooling for measuring whether
Forgekit changes coding-agent outcomes. Harbor runs the same canonical task in
paired A/B arms:

- **Baseline** uses the selected agent and model without Forgekit installed or
  injected workflow instructions.
- **Forge** uses the same task, agent, and model, while its treatment image
  installs either a selected published Forgekit version or an explicitly built
  local tarball and receives the Forge workflow instructions.

For a step-by-step operator walkthrough, including a paired Forge versus
no-Forge run and result inspection, see [`docs/agentic-evals.md`](../docs/agentic-evals.md).

The benchmark is deliberately graded outside Forgekit. A Harbor verifier owns
the hidden checks and emits numeric outcome rewards. Forge's scorecard and
`.forge/` process artifacts are secondary instrumentation: they help explain
what the agent did, but they are not an outcome oracle and must not replace the
external verifier. An agent's final message and visible tests are not proof of
success.

## Status

The initial harness is executable. It includes the `node-health-endpoint`
canonical task, paired-arm runner, result normalizer, unit tests, and a local
no-model smoke validator. The smoke task validates wiring only; it is not
sufficient evidence of an agent effect.

## Install And Run

Install Harbor separately from the Node package and Python project:

```bash
uv tool install harbor==0.20.0
```

Dry run for both paired arms:

```bash
node evals/harbor/run.mjs \
  --task node-health-endpoint \
  --arm both \
  --repetitions 3 \
  --concurrency 2 \
  --agent <agent> \
  --model <model-id> \
  --forgekit-version <published-version> \
  --dry-run
```

To evaluate this checkout without publishing it, build the package explicitly
and select the resulting immutable payload instead of `--forgekit-version`:

```bash
TARBALL_DIR="$(mktemp -d)"
npm pack --workspace=@izkac/forgekit --pack-destination "$TARBALL_DIR"
FORGEKIT_TARBALL="$(find "$TARBALL_DIR" -maxdepth 1 -name '*.tgz' -print -quit)"

node evals/harbor/run.mjs \
  --task node-health-endpoint \
  --arm both \
  --repetitions 1 \
  --concurrency 1 \
  --agent <agent> \
  --model <model-id> \
  --forgekit-tarball "$FORGEKIT_TARBALL" \
  --dry-run
```

`npm pack` runs this checkout's trusted `prepack` lifecycle to refresh the
ignored vendored assets. The evaluator runner itself never invokes packaging
scripts and never publishes. Pass a tarball only from a source you trust.

Real run, using the same inputs without `--dry-run`:

```bash
node evals/harbor/run.mjs \
  --task node-health-endpoint \
  --arm both \
  --repetitions 3 \
  --concurrency 2 \
  --agent <agent> \
  --model <model-id> \
  --forgekit-version <published-version>
```

Use `--arm baseline` or `--arm forge` instead of `--arm both` to run one arm
alone. Keep the task, agent, model, model settings, repetition count, and
concurrency identical when comparing arms. The dry run is intended to print
the staged plan and Harbor argv without invoking Harbor or requiring model
credentials. The real run invokes Harbor once per trial; concurrency controls
how many trials may be active at once, not the number of repetitions. It probes
and records `harbor --version`, requests `/app/.forge` as an artifact only for
the Forge arm, requires one external `reward.json`, and writes a normalized
result for every successful trial. A Harbor process exit alone is not recorded
as an outcome pass.

The runner validates the task, arm, positive repetition and concurrency
values, model and agent parameters, and exactly one Forgekit treatment selector
before starting a trial. `--forgekit-version` refers to a published package;
`--forgekit-tarball` snapshots a readable local file and records its SHA-256 and
byte size without recording the operator's host path. The baseline image never
receives Forgekit. The Forge image verifies the local digest before installing
with lifecycle scripts disabled. The local checkout is never selected
implicitly, and Harbor is not added to the published `packages/cli`
dependencies.

## Task Contract

Each task uses Harbor's task directory shape:

```text
evals/harbor/tasks/<task-id>/
  task.toml
  instruction.md
  environment/
  tests/
```

- `task.toml` contains Harbor metadata plus the task id, category, difficulty,
  and other run configuration.
- `instruction.md` is the agent-facing task. It must not disclose hidden
  assertions or verifier implementation details.
- `environment/` contains the starting repository or fixture and the agent
  image definition. It must not contain the hidden grader, verifier sources,
  or grader-only secrets.
- `tests/` defines a separate Harbor verifier image and its hidden grader. The
  verifier is run outside the agent environment and is never copied or mounted
  into it.
- The hidden grader emits a reward JSON with numeric outcome fields, including
  `functional`, `regression`, `tests_unchanged`, and `shippable`. A
  `tests_unchanged` value of `1` means that the grader found no test tampering.

The `node-health-endpoint` task is a smoke fixture for this
contract. Later task categories are planned, not present yet: small bug fixes
and regressions, feature work, integration and runtime wiring, refactors and
maintenance, tests and verification, and security or edge-case work. The
corpus should include both small triage-eligible tasks and substantial changes
where Forge's planning and verification process could plausibly matter.

## Result Normalization

The runner normalizes real trial output automatically. The standalone interface
is also useful when inspecting or reprocessing artifacts:

```bash
node evals/harbor/normalize-results.mjs \
  --reward <reward.json> \
  --arm <baseline|forge> \
  --task <task-id> \
  --trial <positive-integer> \
  --forge-summary <summary.json> \
  --harbor-result <trial-result.json> \
  --harbor-job-result <job-result.json>
```

Omit either optional instrumentation argument when its artifact is unavailable.
The stable record keeps verifier outcomes separate from instrumentation. Missing
or malformed optional Forge or Harbor data is represented explicitly and does
not downgrade a valid external reward. When Harbor trial/job `result.json` files are present,
the record includes explicit wall-clock, token, cache-token, cost, and retry
fields; unavailable values remain `null`.

## Developer Verification

Run the dependency-free evaluator checks from the repository root:

```bash
npm run test:evals
npm run lint:evals
npm run smoke:evals
```

The smoke command validates metadata, stages and compares both arms, exercises
the untouched and known-good verifier paths, and statically validates all three
Docker build contexts. If the Docker daemon is accessible it also runs
`docker build --check` for the baseline image, Forge image, and separate
verifier image. It never invokes Harbor or a model.

For the 2026-08-09 local verification, all 22 evaluator tests and lint passed. The
hidden verifier produced `{functional:0, regression:1, tests_unchanged:1,
shippable:0}` for the untouched fixture and all ones for the known-good
solution. Docker validation was skipped because this host could not access the
Docker daemon; Harbor/model execution and credentials were intentionally not
used. The existing full workspace test command reported 1,154 passing, zero failing, and one todo test; full lint also passed. The full
workspace commands are:

```bash
npm test
npm run lint
forge spine check
forge brief check
```

## Metrics

The verifier's numeric rewards are the independent outcome data:

- `functional`: the requested behavior passes hidden functional checks.
- `regression`: pre-existing behavior and required interfaces still pass hidden
  regression checks.
- `tests_unchanged`: visible test files were not altered to hide a failure;
  this is the test-tamper measure.
- `shippable`: conservatively `1` only when every required outcome metric
  passes. A missing required metric is not a pass.

Record cost, wall-clock time, input and output tokens, retries, and process
telemetry where Harbor or the agent makes them available. Forge artifacts can
add process detail such as planning, test, review, and runtime-hook activity,
but that detail remains secondary and may be unavailable for the baseline arm.
Missing Forge telemetry must be reported as missing; it must not downgrade a
verifier result or be treated as a failed task.

One smoke task is a wiring check, not an effect-size result. It provides one
task-specific observation, has no meaningful held-out sample, and cannot show
that Forgekit improves agents generally. Claims require paired repetitions
across a larger held-out corpus, with outcome and cost/time comparisons.

## Reproducibility And Isolation

- Stage both arms from one versioned canonical task so the starting fixture and
  task text cannot drift between treatments.
- Hold the task, agent, model, model settings, container inputs, repetition
  count, and concurrency constant across a comparison. Change only the Forge
  treatment.
- Pin and record the Forgekit treatment (published version or local tarball
  SHA-256), Harbor version, task revision, harness revision, image versions,
  and any supported random seed. A local tarball digest identifies the Forgekit
  payload bytes but does not pin registry-resolved transitive dependencies. The smoke
  task pins its Node base image by registry digest and avoids mutable package
  installation in the task Dockerfiles. Real manifests record Harbor's
  resolved agent name/version from its trial result, plus the requested agent,
  model, arm, trial id, and run settings; never put credentials in them.
- Treat model nondeterminism, provider changes, and unpinned dependencies as
  sources of variance. Repeat each arm under the same controls and compare
  paired results rather than pooling unmatched runs.

The verifier is an external boundary. Hidden grader code, hidden tests,
expected outputs, and verifier credentials must remain in `tests/` and the
verifier container only. The agent may change its working environment, but it
must not be able to read or write the verifier. Visible tests are useful task
context, not the independent oracle.

Public coding benchmarks are useful context but are not sufficient evidence for
this question. They may contain training contamination, weak or visible tests,
task distributions unlike Forgekit's targets, and no measurement of cost,
false completion, test tampering, or product-path integrity. Report their
limitations and use held-out or private tasks when making Forge-specific
claims.

## Run Artifacts

The runner writes local artifacts under:

```text
evals/.runs/<run-id>/
```

This includes manifests, generated baseline/Forge staging, Harbor logs and
reward JSON, normalized results, and any available Forge telemetry. Runs can
be large or expensive and are ignored by `evals/.gitignore`; they are not part
of the published package or the benchmark source of truth.
