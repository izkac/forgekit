# Test Forge Against a No-Forge Baseline

This guide explains how to use Forgekit's agentic evaluation harness to run a
controlled comparison between the same coding agent **with Forge** and
**without Forge**.

The harness lives in `evals/` and uses [Harbor](https://harborframework.com/)
for containerized agent execution. It is optional developer and research
tooling; it is not installed by the published Forgekit CLI package.

## What The Comparison Tests

Each benchmark invocation can stage two arms from one canonical task:

| Arm | Forgekit installed | Forge instructions | External verifier |
| --- | --- | --- | --- |
| `baseline` | No | No; use the agent's normal workflow | Yes |
| `forge` | Yes, at the selected published version | Yes | Yes |

Both arms use the same task fixture, hidden verifier, agent, model, repetition
count, and concurrency. The runner's treatment transformation changes only the
arm instruction and, for the Forge arm, the agent Dockerfile install marker.
The smoke suite verifies this isolation.

Outcome metrics come from Harbor's separate verifier, not from Forge's
scorecard, visible tests, or the agent's final message. Forge artifacts are
secondary instrumentation only.

## Current Support Status

The harness is implemented and usable now. It currently includes one canonical
smoke task, `node-health-endpoint`. That task is enough to validate the A/B
wiring, but one small task cannot establish that Forge improves coding agents
in general.

The current runner measures a **published** `@izkac/forgekit` version. It does
not package the current checkout or test uncommitted Forgekit source. Local
tarball treatment is not supported yet.

A real evaluation requires:

- Node.js and the repository dependencies installed.
- Harbor 0.20.0 installed separately.
- An accessible Docker daemon.
- A Harbor-supported agent and model.
- The model provider credentials required by that Harbor agent.
- A published Forgekit semantic version.

## 1. Validate The Harness Without A Model

From the repository root, run:

```bash
npm run test:evals
npm run lint:evals
npm run smoke:evals
```

The smoke command:

- validates the Harbor task metadata and required files;
- stages and compares both treatment arms;
- checks that hidden verifier code does not leak into the agent image;
- grades the untouched fixture and the known-good solution locally;
- validates all Docker build contexts statically;
- runs `docker build --check` when the Docker daemon is accessible;
- never invokes Harbor or a model.

Expected verifier results are:

| Fixture | functional | regression | tests_unchanged | shippable |
| --- | ---: | ---: | ---: | ---: |
| Untouched | 0 | 1 | 1 | 0 |
| Known-good solution | 1 | 1 | 1 | 1 |

A Docker skip is acceptable for the no-model smoke check, but Docker must work
before a real agent evaluation.

## 2. Install And Check Harbor

Install the version used to validate this harness:

```bash
uv tool install harbor==0.20.0
harbor --version
docker info
```

If `docker info` fails, fix Docker daemon access before attempting a real run.
The runner cannot execute the agent or verifier containers without it.

Use Harbor's help to inspect the agents and options available in your
installation:

```bash
harbor run --help
```

Configure the provider credentials required by the selected agent/model. The
runner does not write credentials into its manifests.

## 3. Choose Constant Evaluation Inputs

Set one agent, model, and published Forgekit version and keep them unchanged
between arms:

```bash
export EVAL_AGENT='<harbor-agent>'
export EVAL_MODEL='<provider/model-id>'
export FORGEKIT_VERSION="$(npm view @izkac/forgekit version)"
```

For a fair comparison, do not change model settings, credentials, task files,
or concurrency between the baseline and Forge trials.

## 4. Preview The Paired Run

Always dry-run first:

```bash
node evals/harbor/run.mjs \
  --task node-health-endpoint \
  --arm both \
  --repetitions 1 \
  --concurrency 1 \
  --agent "$EVAL_AGENT" \
  --model "$EVAL_MODEL" \
  --forgekit-version "$FORGEKIT_VERSION" \
  --dry-run | tee /tmp/forge-eval-dry-run.json
```

The dry run stages both tasks, writes trial manifests, and prints the exact
Harbor argv. It does not require model credentials and does not invoke Harbor
or a model.

Inspect the generated plan:

```bash
jq '{runDirectory, taskRevision, harnessRevision, images, settings, arms, trials}' \
  /tmp/forge-eval-dry-run.json
```

You can also inspect the staged treatment directly:

```bash
RUN_DIR="$(jq -r .runDirectory /tmp/forge-eval-dry-run.json)"
diff -ru "$RUN_DIR/arms/baseline" "$RUN_DIR/arms/forge" || true
```

The expected differences are the arm-specific `instruction.md` and the Forge
arm's `environment/Dockerfile` install line.

## 5. Run Forge Versus No Forge

The preferred comparison is one `--arm both` invocation. Start with one paired
trial to confirm credentials, image builds, and model execution:

```bash
node evals/harbor/run.mjs \
  --task node-health-endpoint \
  --arm both \
  --repetitions 1 \
  --concurrency 1 \
  --agent "$EVAL_AGENT" \
  --model "$EVAL_MODEL" \
  --forgekit-version "$FORGEKIT_VERSION" \
  | tee /tmp/forge-eval-run.json
```

This performs two model trials:

1. `baseline`: the agent completes the task using its normal workflow, with no
   Forgekit installation or Forge instructions.
2. `forge`: the same agent/model completes the same task with the selected
   Forgekit package installed and Forge workflow instructions injected.

After the first pair succeeds operationally, use repetitions to account for
model nondeterminism:

```bash
node evals/harbor/run.mjs \
  --task node-health-endpoint \
  --arm both \
  --repetitions 3 \
  --concurrency 2 \
  --agent "$EVAL_AGENT" \
  --model "$EVAL_MODEL" \
  --forgekit-version "$FORGEKIT_VERSION" \
  | tee /tmp/forge-eval-run.json
```

This example creates six billable model trials: three baseline and three Forge.
Concurrency limits how many trials run at once; it does not change the number
of repetitions.

### Running Arms Separately

You can execute only one arm with `--arm baseline` or `--arm forge`:

```bash
# No-Forge control only
node evals/harbor/run.mjs \
  --task node-health-endpoint \
  --arm baseline \
  --repetitions 3 \
  --concurrency 2 \
  --agent "$EVAL_AGENT" \
  --model "$EVAL_MODEL" \
  --forgekit-version "$FORGEKIT_VERSION"

# Forge treatment only
node evals/harbor/run.mjs \
  --task node-health-endpoint \
  --arm forge \
  --repetitions 3 \
  --concurrency 2 \
  --agent "$EVAL_AGENT" \
  --model "$EVAL_MODEL" \
  --forgekit-version "$FORGEKIT_VERSION"
```

Separate invocations are useful for diagnosis, but `--arm both` is preferred
for a paired experiment because it stages both arms from the same canonical
revision and records one comparison plan.

## 6. Inspect Results

The runner prints a JSON plan whose `runDirectory` points to ignored local
artifacts under `evals/.runs/`:

```bash
RUN_DIR="$(jq -r .runDirectory /tmp/forge-eval-run.json)"
find "$RUN_DIR/trials" -maxdepth 2 -type f | sort
```

Each successfully verified trial contains:

- `manifest.json`: task/harness revisions, arm, repetition, requested inputs,
  pinned images, Harbor version/argv, and resolved agent information;
- `harbor.stdout.log` and `harbor.stderr.log`;
- Harbor job, verifier, and downloaded artifact output;
- `normalized-result.json`: independent outcome plus instrumentation;
- `forge-summary.json` when Forge artifacts were collected.

Print a compact comparison table:

```bash
printf 'arm\ttrial\tfunctional\tregression\ttests_unchanged\tshippable\tcost_usd\n'
find "$RUN_DIR/trials" -name normalized-result.json -exec \
  jq -r '[.arm, .trial, .outcome.functional, .outcome.regression,
          .outcome.tests_unchanged, .outcome.shippable,
          .instrumentation.harbor.cost_usd] | @tsv' {} \
  \;
```

Interpret the outcome fields as follows:

- `functional`: the requested endpoint and required added test passed the
  independent checks.
- `regression`: pre-existing behavior still works.
- `tests_unchanged`: the original visible regression test was not altered or
  disabled.
- `shippable`: `1` only when every required outcome metric passes.

A manifest status of `verified` means the external reward was found and
normalized. It does **not** mean the task was shippable; inspect
`outcome.shippable`.

Missing Forge telemetry does not turn a valid verifier result into a failure.
Likewise, Forge scorecards cannot upgrade a failing external result.

## 7. Compare The Arms Fairly

For each repetition, compare baseline trial `N` with Forge trial `N`. At a
minimum, report:

- success counts and `shippable` rate by arm;
- functional, regression, and test-tamper failures;
- wall-clock time;
- input/output/cache tokens;
- cost;
- retries;
- missing instrumentation;
- agent, model, Forgekit version, Harbor version, task revision, harness
  revision, and pinned image inputs.

Use multiple repetitions because coding models are nondeterministic. Do not
pool unmatched runs produced with different models, provider versions,
credentials, task revisions, or concurrency settings.

The initial task is intentionally small and may make Forge's process overhead
look disproportionately expensive. Treat it as a harness smoke test, not an
effect-size benchmark. A credible Forge impact claim requires a larger,
versioned, held-out corpus containing bugs, features, integrations, refactors,
tests, and security/edge-case work.

## Troubleshooting

### `docker info` reports permission denied

The Docker CLI exists but the current user cannot access the daemon. Fix the
host's Docker group/socket or Docker Desktop configuration, start a new shell,
and rerun `docker info`.

### `harbor` is not found

Confirm the uv tool directory is on `PATH`:

```bash
uv tool list
uv tool update-shell
```

Then start a new shell and rerun `harbor --version`.

### Forgekit fails during the Forge image build

Verify the selected version is published:

```bash
npm view "@izkac/forgekit@$FORGEKIT_VERSION" version
```

The runner intentionally does not install the local checkout.

### A trial exits without `normalized-result.json`

Inspect its `manifest.json`, `harbor.stderr.log`, and Harbor job output. The
runner requires exactly one verifier-owned `verifier/reward.json`; an agent
artifact named `reward.json` is deliberately rejected as an outcome source.

### The Forge trial has no Forge telemetry

Check whether the agent actually started a Forge workflow and inspect Harbor's
downloaded `/app/.forge` artifact. Missing process telemetry is represented
explicitly and does not invalidate the independent verifier outcome.

## Safety And Cost Notes

A real run executes coding agents in containers and can spend provider tokens.
Review new benchmark tasks and verifier boundaries before running them. Start
with one repetition and concurrency one, confirm the resulting costs, and only
then increase repetitions.

Run artifacts can be large and may contain model transcripts or process
metadata. They are ignored by Git under `evals/.runs/`; handle them according
to the sensitivity of the task and provider data.
