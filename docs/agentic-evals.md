# Run Versioned Forge Versus No-Forge Evaluations

This guide runs the same coding agent with and without Forgekit on an
explicitly selected evaluation corpus. The harness lives in `evals/`, uses
[Harbor](https://harborframework.com/) for containerized execution, and is not
installed by the published Forgekit CLI package.

## What Is Being Compared

| Arm | Forgekit installed | Workflow instruction | Outcome grader |
| --- | --- | --- | --- |
| `baseline` | No | Agent's normal workflow | Separate hidden verifier |
| `forge` | One selected version/tarball | Forge workflow | Same separate hidden verifier |

The outcome is the verifier reward, not the agent's final message, visible
tests, Forge scorecard, or `.forge/` telemetry. Process telemetry can explain a
result but cannot upgrade or downgrade the verifier outcome.

The evaluator accepts only two checked-in corpus IDs. Omitting `--corpus`
selects `forgekit-held-out-v1`, preserving the historical default. Passing
`--corpus forgekit-hard-v2` selects its separate manifest and task root.
Unknown IDs, path-like values, and arbitrary filesystem roots fail before task
staging.

The implemented `forgekit-held-out-v1` pilot has six public, versioned tasks:

| Category | Task id | Requested work |
| --- | --- | --- |
| bug | `pagination-boundary` | Exact-page pagination boundary fix and regression test |
| feature | `node-health-endpoint` | New health endpoint |
| integration | `audit-log-wiring` | Persistence/audit adapter wiring and effect order |
| refactor | `router-extraction` | Router extraction and decoded item parameter route |
| tests | `csv-formula-regression` | Boundary tests and CSV formula neutralization |
| security | `encoded-path-traversal` | Encoded traversal hardening without filename regressions |

The v1 manifest and complete contents of all six v1 task trees are frozen by
`evals/harbor/corpus-v1.lock.json`. CI hashes them and fails on drift; historical
v1 must not be changed in place. A substantive change requires a new corpus ID.

`forgekit-hard-v2` is a companion corpus with four reviewed tasks:

| Category | Task id | Version | Dominant contract | Separate verifier / semantic mutant | Three contexts |
| --- | --- | --- | --- | --- | --- |
| bug | `reservation-confirmation-race` | `1.0.1` | Concurrent confirmation admission, replay/conflict/retry/expiry and HTTP behavior | No-network `tests/` verifier checks deterministic overlap and HTTP outcomes; `tests/mutants/confirmation-service.mjs` permits a double charge | baseline agent `environment/`; Forge agent staged `environment/`; separate verifier `tests/` |
| security | `tenant-signed-downloads` | `1.0.0` | Tenant binding across authenticated, routed, signed, and stored document context; canonical expiry and fail-closed downloads | No-network `tests/` verifier checks tenant/signature/expiry/download behavior; `tests/mutants/capability-service.mjs` omits tenant binding from the signed payload | baseline agent `environment/`; Forge agent staged `environment/`; separate verifier `tests/` |
| tests | `partial-refund-ledger-invariants` | `1.0.0` | Cumulative integer-cent balance, failed-attempt non-consumption, exact boundary, idempotency and conflict effects | No-network `tests/` verifier plus required separate table-driven agent test; `tests/mutants/refund-service.mjs` accounts only for the latest successful entry | baseline agent `environment/`; Forge agent staged `environment/`; separate verifier `tests/` |
| integration | `carrier-event-reconciliation` | `1.0.0` | Carrier normalization, `(carrier,eventId)` idempotency, append-before-project ordering and provider precedence | No-network `tests/` verifier checks normalization, deduplication, ordering and terminal delivery; `tests/mutants/reconciliation-service.mjs` removes carrier scope and permits regression | baseline agent `environment/`; Forge agent staged `environment/`; separate verifier `tests/` |

The four rows yield exactly twelve build-check contexts. The verifier context
is separate and no-network; neither it nor its semantic mutant is mounted into
an agent context. These are infrastructure and verifier-integrity checks, not
provider-backed effectiveness evidence.

Hard-v2 remains an **incomplete four-task foundation**, pending the Feature
and Refactor tasks. It is not yet a complete six-category corpus, and its
infrastructure, oracle runs, and verifier tests are not provider-backed
evidence that Forgekit is effective. No provider effectiveness evidence has
been produced for hard-v2 at HEAD.

Each task's grader lives in its own `tests/` verifier context. Harbor's
`environment_mode = "separate"` and no-network verifier keep it out of the
agent container at execution time. Because the tasks and graders are checked
into a public repository, "held out" does not mean private or demonstrably
contamination-free.

## 1. Check Prerequisites And Budget

A real run needs:

- Node.js with this repository's dependencies installed;
- Harbor 0.20.0;
- Docker daemon access;
- a Harbor-supported coding agent and model;
- that provider's credentials in the environment; and
- one explicit Forgekit treatment.

Install and check the external runtime:

```bash
uv tool install harbor==0.20.0
harbor --version
docker info
harbor run --help
```

Set the agent and model identifiers supported by your Harbor installation and
configure the provider credentials Harbor requires:

```bash
export EVAL_AGENT='<harbor-agent>'
export EVAL_MODEL='<provider/model-id>'
```

Do not put credential values in task text, agent/model identifiers, seeds, or
shell transcripts that will be shared. The runner inherits credentials through
its environment and does not intentionally serialize their values, but Harbor,
agent, and provider logs can contain sensitive content.

`--arm both --repetitions N` creates `2 * N` billable model trials **per task**.
The full six-task pilot therefore creates `12 * N` model trials. Provider
pricing, retries, cache behavior, and rate limits vary. Start with one task, one
repetition, and concurrency one before authorizing the full spend.

## 2. Validate The Infrastructure Without A Model

From the repository root:

```bash
npm run test:evals
npm run lint:evals
npm run smoke:evals
npm run smoke:evals:hard-v2
```

`npm run smoke:evals` remains the exact v1 smoke. It validates all six v1
tasks, baseline/Forge staging, hidden-verifier isolation, untouched and
known-good verifier paths, and the three Docker contexts for each v1 task.
`npm run smoke:evals:hard-v2` selects the four reviewed hard-v2 tasks. For each
task it validates manifest/task metadata, including non-empty task-local
`semantic_mutants`, dry-run baseline/Forge staging and verifier isolation, plus
the required host matrix: untouched negative, oracle positive, alternate
positive, tamper negative, no-added-test negative, and mutant negative. It
validates exactly three Docker build-check contexts per task—twelve contexts
total: baseline agent, Forge agent, and separate verifier—running
`docker build --check` when Docker is available or reporting Docker validation
as skipped after local context-reference checks. It never invokes Harbor or a
model.

`test:evals` also runs the hard-v2 host and adversarial cases. Docker
build-check is build-context and Dockerfile lint/check validation; it does not
build an image or exercise installation or runtime behavior. Both smoke paths
rely on POSIX shell and tooling, so run them on Linux, another POSIX host, or
WSL; native Windows semantics are not currently supported.

The checked-in `solution/solve.sh` is a known-good verifier oracle. Its passing
reward proves only that the verifier accepts that fixture. An untouched fixture
proves only the expected negative path. A Harbor `nop` run can additionally
exercise jobs, containers, artifacts, verification, and normalization. Smoke,
`nop`, and oracle results validate infrastructure only; none measures coding
agent performance or Forgekit effectiveness.

## 3. Package This Checkout Without Publishing

Create a trusted local package explicitly:

```bash
export TARBALL_DIR="$(mktemp -d)"
npm pack --workspace=@izkac/forgekit --pack-destination "$TARBALL_DIR"
export FORGEKIT_TARBALL="$(find "$TARBALL_DIR" -maxdepth 1 -name '*.tgz' -print -quit)"
sha256sum "$FORGEKIT_TARBALL"
```

`npm pack` runs this checkout's trusted `prepack` lifecycle and refreshes its
vendored package assets. It creates a local tarball; it does **not** publish.
The evaluation runner neither packages nor publishes anything and never uses
the checkout implicitly.

`--forgekit-tarball "$FORGEKIT_TARBALL"` makes the runner snapshot the bytes,
record SHA-256 and size without recording the original host path, and stage the
digest-named payload only in the Forge arm. The Forge image verifies the digest
and installs with lifecycle scripts disabled. A tarball digest does not pin
transitive packages later resolved from a registry. Use a tarball only from a
source you trust.

To evaluate an already published package instead, use
`--forgekit-version <semantic-version>`. Supply exactly one of
`--forgekit-tarball` and `--forgekit-version`, including for a baseline-only
run, so the planned cohort always identifies its treatment.

## 4. Dry-Run The Hard-v2 Foundation

Choose a stable seed and preview the command:

```bash
export EVAL_SEED='hard-v2-foundation'
export EVAL_CORPUS='forgekit-hard-v2'
export EVAL_TASK='reservation-confirmation-race'

node evals/harbor/run.mjs \
  --corpus "$EVAL_CORPUS" \
  --task "$EVAL_TASK" \
  --arm both \
  --repetitions 1 \
  --concurrency 1 \
  --seed "$EVAL_SEED" \
  --agent "$EVAL_AGENT" \
  --model "$EVAL_MODEL" \
  --forgekit-tarball "$FORGEKIT_TARBALL" \
  --dry-run | tee /tmp/forge-eval-dry-run.json
```

Dry-run requires no model credentials and does not invoke or probe Harbor. It
stages both arms, writes `plan.json` and a manifest for every planned trial,
and prints the same portable plan shape that is persisted. Neither stdout nor
the persisted provenance includes an absolute run directory. The plan
identifies itself by `runId`; Harbor argv contains exact run-relative locators
and executes with the run directory as its working directory. Inspect it before spending:

```bash
jq '{runId, corpus, taskVersion, taskRevision, harnessRevision, seed, schedule, images, settings, trials}' \
  /tmp/forge-eval-dry-run.json

RUNS_ROOT="${FORGEKIT_EVAL_RUNS_ROOT:-evals/.runs}"
RUN_ID="$(jq -r .runId /tmp/forge-eval-dry-run.json)"
RUN_DIR="$RUNS_ROOT/$RUN_ID"
diff -ru "$RUN_DIR/arms/baseline" "$RUN_DIR/arms/forge" || true
```

Expected arm differences are the appended arm instruction, the Forge install
lines, and the digest-named tarball in the Forge environment. The baseline and
separate verifier must not receive that tarball. A dry-run directory is
recreated deterministically for the same inputs. Use only one dry-run writer per
runs root: concurrent writers with the same derived run id can replace or
interleave that directory. A dry-run is not accepted by the aggregator as
completed evidence. This hard-v2 example is deliberately dry-run only: it
validates selection and staging without claiming a provider outcome.

## Hard-v2 Calibration Protocol (Preregister Before Execution)

Treat calibration as a reproducibility check, not provider-effectiveness
evidence. Freeze and record this checklist before authorizing any model-backed
run:

- corpus `forgekit-hard-v2`, task ID, exact task version, and canonical
  task-tree revision;
- immutable Forgekit treatment identity: published version or artifact
  digest (and tarball byte count/digest when applicable);
- agent ID, model ID, model settings, Harbor/harness revision, and image
  identities;
- seed, `--arm both`, repetition count, `--concurrency 1`, and the planned
  order frozen before execution (then the exact recorded order);
- operator, start/end dates and timezone, retention/redaction procedure,
  budget, and a spend/stop rule for cost, operational failures, or missing
  verifier rewards.

`--arm both --repetitions 1` is one paired calibration (one baseline/Forge
pair), not an exactly counterbalanced design: the hash-selected starting arm
has one extra first position. Report that first-position imbalance. Exact
within-task first-position counterbalancing starts at an even repetition
count, minimally `--repetitions 2`; keep the seed and task revision fixed.
Do not pool a one-pair calibration with a later counterbalanced cohort unless
that decision was preregistered.

Any substantive post-calibration change to task instructions, fixtures,
verifier, mutant, or task tree requires a task-version bump. Exclude the
superseded calibration from effectiveness analysis and preregister the new
revision as a new cohort. A changed treatment digest/version, agent/model,
seed, order, concurrency, retention rule, spend/stop rule, or date window is
also a new cohort control decision.

### Copyable Templates For The Three New Tasks

These commands contain placeholders only: no credentials, host paths, run IDs,
results, or completed-run claims. A dry-run stages without a provider. Remove
`--dry-run` only after the checklist and spend authorization are frozen.

```bash
# tenant-signed-downloads — dry-run
node evals/harbor/run.mjs --corpus forgekit-hard-v2 --task tenant-signed-downloads --arm both --repetitions 1 --concurrency 1 --seed <calibration-seed> --agent <agent-id> --model <model-id> --forgekit-version <published-semver> --dry-run

# tenant-signed-downloads — real run (one paired calibration)
node evals/harbor/run.mjs --corpus forgekit-hard-v2 --task tenant-signed-downloads --arm both --repetitions 1 --concurrency 1 --seed <calibration-seed> --agent <agent-id> --model <model-id> --forgekit-version <published-semver>

# partial-refund-ledger-invariants — dry-run
node evals/harbor/run.mjs --corpus forgekit-hard-v2 --task partial-refund-ledger-invariants --arm both --repetitions 1 --concurrency 1 --seed <calibration-seed> --agent <agent-id> --model <model-id> --forgekit-version <published-semver> --dry-run

# partial-refund-ledger-invariants — real run (one paired calibration)
node evals/harbor/run.mjs --corpus forgekit-hard-v2 --task partial-refund-ledger-invariants --arm both --repetitions 1 --concurrency 1 --seed <calibration-seed> --agent <agent-id> --model <model-id> --forgekit-version <published-semver>

# carrier-event-reconciliation — dry-run
node evals/harbor/run.mjs --corpus forgekit-hard-v2 --task carrier-event-reconciliation --arm both --repetitions 1 --concurrency 1 --seed <calibration-seed> --agent <agent-id> --model <model-id> --forgekit-version <published-semver> --dry-run

# carrier-event-reconciliation — real run (one paired calibration)
node evals/harbor/run.mjs --corpus forgekit-hard-v2 --task carrier-event-reconciliation --arm both --repetitions 1 --concurrency 1 --seed <calibration-seed> --agent <agent-id> --model <model-id> --forgekit-version <published-semver>
```

## 5. Understand Seed, Order, And Concurrency

For `--arm both`, repetition `N` is a pair block: baseline and Forge for the
same task and repetition. Scheduling is exact and repeatable:

1. SHA-256 hashes `seed + NUL + task id + NUL + canonical task revision`.
2. An even first hash byte chooses baseline first; an odd byte chooses Forge
   first.
3. The first arm alternates on subsequent repetitions.
4. The two trials in each block execute serially in the recorded order.

The default seed is `default`. `--seed` accepts at most 128 letters, digits,
dots, underscores, or hyphens. It controls ordering only; it is not sent to the
model and does not seed model sampling. Even repetition counts balance first
position exactly. Odd counts necessarily favor the hash-selected starting arm
by one; `schedule.imbalance` discloses that fact. `plan.json` also records the
start hash, starting arm, every arm order, and first-arm counts.

For paired runs, `--concurrency N` means at most `N` **pair blocks** are active.
It does not mean `N` total arm trials scheduled as a flat queue. Each active
pair runs only one Harbor trial at a time (`--n-concurrent 1`), but trials from
different pairs can overlap. If one arm fails operationally, its partner and
all other pairs are still attempted; the runner persists the failures and exits
nonzero after completing the schedule. For `--arm baseline` or `--arm forge`,
concurrency counts ordinary single-arm trials.

Use `--concurrency 1` for causal trials. This preserves one global pair-block
sequence and avoids overlap-related provider/load interference. Higher values
save wall-clock time but make a causal reading weaker even though each pair's
internal order is preserved. Neither a seed nor concurrency one removes model
nondeterminism, provider changes, temporal drift, or unpinned dependency drift.

## 6. Run The V1 Pilot

The current hard-v2 companion is incomplete and has no provider effectiveness
evidence. The established six-task run instructions below therefore continue
to describe v1. Reset the variables from the hard-v2 dry-run; omission of
`--corpus` intentionally exercises the v1 default:

```bash
export EVAL_SEED='pilot-v1'
export EVAL_TASK='pagination-boundary'

node evals/harbor/run.mjs \
  --task "$EVAL_TASK" \
  --arm both \
  --repetitions 1 \
  --concurrency 1 \
  --seed "$EVAL_SEED" \
  --agent "$EVAL_AGENT" \
  --model "$EVAL_MODEL" \
  --forgekit-tarball "$FORGEKIT_TARBALL" \
  | tee /tmp/forge-eval-pagination-boundary.json
```

During real execution the runner writes sanitized `[eval-progress]` lifecycle
messages to stderr and a heartbeat every 30 seconds, while stdout remains one
JSON plan suitable for `tee`. Use `--progress-interval-seconds N` (0–86400) to change the
heartbeat cadence or `0` to disable periodic heartbeats; start and terminal
lifecycle messages remain enabled. Progress lines contain safe run/trial/task identities, arm, status, ordinal,
trial/outcome counts, and elapsed time only—never prompts, credentials, or host
paths.

Confirm credentials, builds, rewards, normalized results, and actual cost. Then
choose a repetition count justified by the trial plan and budget. Use the same
agent, model and model settings, treatment bytes, seed, repetitions,
concurrency, images, provider setup, and harness revision for every task in the
cohort. Invoke the runner once for each task id:

```text
pagination-boundary
node-health-endpoint
audit-log-wiring
router-extraction
csv-formula-regression
encoded-path-traversal
```

For example, a planned multi-repetition task run remains serial at the pair
level:

```bash
node evals/harbor/run.mjs \
  --task node-health-endpoint \
  --arm both \
  --repetitions 3 \
  --concurrency 1 \
  --seed "$EVAL_SEED" \
  --agent "$EVAL_AGENT" \
  --model "$EVAL_MODEL" \
  --forgekit-tarball "$FORGEKIT_TARBALL" \
  | tee /tmp/forge-eval-node-health-endpoint.json
```

Separate `--arm baseline` and `--arm forge` runs are supported for diagnosis
and can later be paired by the aggregator when their cohort, task revision, and
task/repetition cells align. They may be temporally separated, however, so they
are weaker causal evidence than one paired invocation even when provenance
matches. Prefer one `--arm both` run: it stages both arms from one canonical
revision and records one counterbalanced plan.

## 7. Inspect Provenance And Trial Results

The printed JSON supplies a portable `runId`. Combine it with the same runs
root used for execution (the default is ignored `evals/.runs/` storage):

```bash
RUNS_ROOT="${FORGEKIT_EVAL_RUNS_ROOT:-evals/.runs}"
RUN_ID="$(jq -r .runId /tmp/forge-eval-node-health-endpoint.json)"
RUN_DIR="$RUNS_ROOT/$RUN_ID"
jq . "$RUN_DIR/plan.json"
find "$RUN_DIR/trials" -maxdepth 2 -type f | sort
```

`plan.json` is written before model execution and finalized afterward. It
records:

- selected corpus id/schema/manifest revision, task/category, semantic
  `taskVersion`, canonical task-tree revision, and corpus-mapped task locator;
- harness revision, images, agent/model, treatment digest/version, seed and
  settings;
- the counterbalance derivation and planned arm order;
- staged arms, trial/manifests, planned and actual execution order, terminal
  status, and timestamps.

Each `trials/<trial-id>/manifest.json` repeats the corpus, `taskVersion`, task
revision, and harness provenance and binds its trial to them. For hard-v2, the
manifest task version must match `task.toml`; disagreement fails before
staging. The trial manifest records Harbor argv/version with the exact
run-relative locators used during
execution, requested inputs, and path-safe resolved identity fields (`name`,
numeric `version`, and `model_info.name`/`provider`) when the safe identity matches the requested
agent/model. Unknown agent-info fields are omitted and invalid identity leaves become `null`.
Manifests also record schedule/arm ordinal,
status/timestamps, errors, and reward,
Harbor result, Forge summary, and normalized-result references when available.
A manifest status of `verified` means an external verifier reward was found and
normalized; it does **not** mean `shippable` is one. Failed manifests remain in
the final plan. The runner continues the schedule, then returns a nonzero exit
when any trial failed operationally.

Print verified outcomes without silently inventing failed rows:

```bash
printf 'arm	repetition	functional	regression	tests_unchanged	shippable	cost_usd
'
find "$RUN_DIR/trials" -name normalized-result.json -exec \
  jq -r '[.arm, .trial, .outcome.functional, .outcome.regression,
          .outcome.tests_unchanged, .outcome.shippable,
          .instrumentation.harbor.cost_usd] | @tsv' {} \
  \;
```

`functional`, `regression`, `tests_unchanged`, and `shippable` are binary
verifier outcomes. `shippable` is one only when every required outcome passes.
Wall time, tokens, cache tokens, cost, retries, and Forge telemetry are optional
instrumentation. Missing process telemetry remains missing and does not change
a valid outcome.

## 8. Aggregate With Explicit Missingness

Pass every task run directory as a repeated option:

```bash
node evals/harbor/aggregate-results.mjs \
  --run-directory evals/.runs/<pagination-run> \
  --run-directory evals/.runs/<health-run> \
  --run-directory evals/.runs/<audit-run> \
  --run-directory evals/.runs/<router-run> \
  --run-directory evals/.runs/<csv-run> \
  --run-directory evals/.runs/<traversal-run> \
  > /tmp/forge-eval-aggregate.json

jq '{cohort, observations, primary, pairs, categories, tasks, limitations}' \
  /tmp/forge-eval-aggregate.json
```

`--run-directory` is repeatable. Given unchanged persisted inputs, aggregation
is repeatable; it does not rerun models. It accepts completed and
completed-with-failures non-dry plans and fails closed on unsafe/malformed
references, duplicate cells, or missing/inconsistent provenance. All runs must
share agent, model, treatment, harness revision, corpus identity/revision,
repetitions, concurrency, and seed. Each baseline/Forge pair must additionally
match task revision, corpus provenance, category, and agent/verifier images.
The aggregator also requires plan/manifest schedule and Harbor provenance and
checks their agreement. Any mismatch is an error, not a warning or an
incomplete observation.

A **complete pair** has verified outcomes for baseline and Forge at the same
task and repetition. An operational failure or absent normalized reward makes
that pair incomplete. `pairs.complete`, `pairs.incomplete`, and
`pairs.incomplete_pairs` show the accounting. Incomplete pairs do not enter
paired deltas. They are missing observations, not outcome zeros. Similarly,
missing cost/time/token/retry values are omitted with explicit observation and
missing-pair counts; never reinterpret them as zero cost or time.

The primary report field is the equal-task macro delta for `shippable`:

1. compute `Forge - baseline` for each complete repetition pair;
2. average those deltas within each task; and
3. average the available task means with equal task weight.

`primary.complete_tasks` reports how many tasks contribute. A task with no
complete pair is absent from the primary estimand and must be disclosed.

Overall arm rates and `pairs.outcomes.*.mean_delta` pool observations and are
micro, descriptive metrics. Per-task, per-category, cost, token, time, retry,
win/loss/tie, and optional telemetry summaries are also descriptive. Report
them as diagnostics rather than selecting whichever summary is favorable.

The aggregator does not perform significance tests, confidence intervals,
power analysis, practical-effect thresholds, or an automatic effectiveness or
shipping verdict. Analysis decisions and thresholds should be preregistered
outside the tool.

## 9. Protect Run Data

`evals/.runs/` is Git-ignored and excluded from the published npm package, but
its contents are not anonymous or automatically safe to share. Stdout plans,
persisted plans, and manifests use portable relative task/artifact/staging
locators and omit the absolute run directory. Locate a run by combining its
`runId` with the same `FORGEKIT_EVAL_RUNS_ROOT` used for execution, or with the
default `evals/.runs`. Harbor executes from that run directory using the exact
relative argv recorded in provenance.

Forge artifact summaries and normalized telemetry use a trial-Harbor-output-relative
`artifactLocator` plus a relative file inventory; resolve the locator beneath
`$RUN_DIR/trials/<trial-id>/harbor`. They do not serialize the host-absolute
artifact discovery path. Raw Harbor logs and downloaded artifacts
can still include host paths, source files, hidden-verifier output, model
transcripts, Forge process data, and provider metadata. Although the local
tarball source path is omitted and credential values are not intentionally
written, inspect and redact the entire run before moving, sharing, or archiving
it. Never commit run artifacts.

Preserve unmodified `plan.json`, manifests, normalized records, logs, corpus
revision, task revision, harness revision, treatment digest/version, agent and
model identities, seed, order, concurrency, and dates for auditability. If
privacy policy prevents retaining raw transcripts or source, define and record
a redaction/retention procedure before the run rather than silently deleting
provenance afterward.

## 10. Interpret The Corpora Conservatively

V1 contains six small dependency-free Node fixtures and only one task per
category. Hard-v2 currently contains four reviewed tasks, so it remains an
incomplete four-task foundation pending the Feature and Refactor tasks rather
than a representative hard corpus.
Neither represents other languages, large repositories, long-horizon
maintenance, production integrations, or all coding-agent use. Public
availability introduces contamination risk; separate hidden verifiers reduce
execution-time leakage but cannot prove task novelty. Model nondeterminism,
provider drift, small samples, order effects, and missing trials remain
limitations.

For `reservation-confirmation-race`, the separate no-network verifier uses
fixed inputs, a manual clock, and deferred barriers instead of timing sleeps.
Its public deterministic harness keeps scheduling and assertions in a trusted
parent. In the verifier container, candidate modules execute in a child worker
under the configured untrusted UID/GID and exchange commands/results over
dedicated RPC pipes whose accepted result frames carry a per-worker nonce. It
checks same-key overlap, different-key conflict, failed-payment retry, expiry
admission, and unrelated-reservation progress.

The harness also drives the real HTTP adapter. Confirmation must succeed once,
conflict must preserve the `already_confirmed` domain behavior as HTTP 409,
expiry must remain HTTP 410 without charging, and an unknown route must remain
HTTP 404; incompatible lookalike errors that degrade these responses to HTTP
500 fail verification. Agent-added `src/*.test.mjs` files must pass normally
and kill one complete API-compatible concurrency mutant with an assertion
failure; import, syntax, bootstrap, crash, and timeout failures do not count.
The visible tests and package metadata are protected, and both reference and
structurally different positive solutions pass.

For `tenant-signed-downloads`, the separate no-network verifier checks that
authenticated, routed, capability-signed, and document-store tenant IDs agree.
Capabilities must canonically bind tenant, document, and integer expiry; the
exact expiry boundary and malformed signature input fail closed without
exposing bytes; valid same-tenant downloads preserve their response bytes and
headers. Its semantic mutant and protected-test checks assess this requested
contract, not general security or production safety.

For `partial-refund-ledger-invariants`, the separate no-network verifier checks
that successful refunds are accumulated in integer cents against one charge.
Validation errors, missing charges, rejected over-limit attempts, and gateway
failures do not consume refundable balance, even when an audit ledger records
the failed attempt; an amount exactly equal to the remaining balance is
accepted. Replaying a successful idempotency key returns the original result
without another gateway call or ledger append, while reusing that key with a
different amount fails before either effect. The task separately requires a
table-driven agent test in a new `src/*.test.mjs` file; the protected visible
test and package metadata remain unchanged.

For `carrier-event-reconciliation`, the separate no-network verifier checks
configured carrier normalizers that project different payload shapes into one
canonical event. Event identity is scoped to `(carrier, eventId)`, so duplicate
delivery has no second append or projection effect while equal provider IDs
from different carriers remain independent. Accepted events append before
shipment projection; provider sequence and occurred-at precedence prevent an
older arrival from regressing a newer projection, and `delivered` is terminal.
Unknown carriers and malformed payloads fail before either store is written.

Those controls test grader integrity, not every possible schedule or solution.
The public probe can be contaminated, one mutant is only a proxy for one
semantic test-quality property, and a mutant kill does not prove broad test
quality or production concurrency safety. A separate verifier prevents the
grader from being mounted into the agent container during execution; it does
not make public code private. None of the hard-v2 infrastructure, deterministic
checks, mutations, or oracle fixtures is provider effectiveness evidence.

Report task-level outcomes, complete/incomplete pairs, missingness, cost and
time, cohort controls, and uncertainty. Do not infer general or causal
Forgekit effectiveness from smoke, `nop`, oracle fixtures, a single task, or a
raw aggregate delta. A stronger claim needs adequate repetitions and power,
uncertainty and robustness analysis, predefined decision criteria, and more
private or independently maintained held-out work.

## Troubleshooting

### `docker info` is denied

Fix Docker Desktop, daemon, socket, or group access and open a new shell. The
no-model smoke may skip Docker checks, but real Harbor execution cannot.

### `harbor` is not found

```bash
uv tool list
uv tool update-shell
harbor --version
```

Open a new shell after changing `PATH`.

### The Forge image cannot install the tarball

Compare the selected file with the treatment metadata and staged install:

```bash
sha256sum "$FORGEKIT_TARBALL"
jq '.settings.forgekitTreatment' "$RUN_DIR/plan.json"
grep -n 'forgekit-treatment' "$RUN_DIR/arms/forge/environment/Dockerfile"
```

For a published version, check
`npm view "@izkac/forgekit@<version>" version`.

### A trial has no `normalized-result.json`

Inspect its manifest status/error, `harbor.stderr.log`, and Harbor job output.
The runner requires exactly one verifier-owned `verifier/reward.json` and
rejects an agent artifact merely named `reward.json`. Treat the arm as an
operationally missing outcome, not a zero.

### The Forge result has no Forge telemetry

Inspect the downloaded `/app/.forge` artifact and whether the agent actually
started a Forge workflow. Missing Forge telemetry is explicit optional
instrumentation and does not invalidate a verified reward.
