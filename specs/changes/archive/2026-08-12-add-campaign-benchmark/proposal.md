# Add the campaign benchmark

## Why

The existing evaluator cannot detect a difference between Forge and a plain
agent, and the runs already collected say so. Across 54 completed pairs in
`evals/.runs` (`claude-code` / `claude-sonnet-5`), 47 were ties, 6 favoured the
baseline and 1 favoured Forge, while Forge cost 5.7x more per trial ($2.72 vs
$0.48) and took 2.8x longer. Those figures pool runs across seeds and dates,
which `aggregate-results.mjs` refuses by design, so the exact delta is
indicative rather than preregistered — but the 87% tie rate is robust and is
what this change responds to.

The tie rate has three structural causes. Three of four hard-v2 tasks sit at a
ceiling where both arms pass nearly every repetition. `carrier-event-reconciliation`
sits at a floor, failing in both arms in 13 of 13 pairs. And `shippable` is a
single bit, so partial progress is invisible.

Finer-grained scoring does not fix this on its own: on the ceiling tasks both
arms already meet every requirement, so counts would still read n/n vs n/n. The
deeper problem is the dependent variable. Forge does not claim to make a model
better at a self-contained puzzle. It claims the model will not report false
completion, will not silently drop a requirement, will not break untouched
behaviour, and will not leave a capability unwired. A single pass/fail on
one-shot work measures none of those.

This change adds a second corpus shaped around what Forge actually claims: a
**campaign** of six sequential change requests against one repository, each
handled by a fresh agent with no memory, working on whatever the previous
episode left behind. The measured question is whether the process leaves the
repository in a state the next agent can pick up.

## What Changes

- **New corpus `forgekit-campaign-v1`** — one Node 22 order/payment service and
  six ordered episodes, each with its own instruction, hidden requirement
  checks and regression checks over all earlier episodes.
- **Episode sequencing in the runner** — a campaign executes its episodes in
  order, each in a fresh agent container, with the previous episode's `/app`
  output mounted as the next episode's starting state. Arm staging, treatment
  selection and seeded pair ordering are unchanged except that they now apply
  at campaign level.
- **Counted reward metrics** — rewards carry `requirements_met` / `requirements_total`
  and `regression_met` / `regression_total` alongside the existing binary
  metrics, plus a new `false_completion` metric. Reward schema version bumps;
  existing hard-v2 rewards stay readable.
- **Per-episode aggregation** — the aggregator reports outcomes per episode
  index and the paired delta by episode index, so a widening gap is directly
  readable.
- **Mechanical blocker reporting** — episodes require `BLOCKED.md` at the
  repository root when a requirement cannot be met without breaking an existing
  one, keeping trap episodes gradeable without reading agent prose.

Not in scope: retrofitting hard-v2 (it stays frozen), a clean-repo reset
control condition, mutation testing, and diagnosing why
`carrier-event-reconciliation` is unsolvable in both arms.

## Capabilities

- `benchmark-harness`: campaign sequencing, counted rewards, per-episode
  aggregation — delta at `specs/benchmark-harness/spec.md`
- `evaluation-corpus`: the `forgekit-campaign-v1` corpus, its episode contract
  and its grading rules — delta at `specs/evaluation-corpus/spec.md`

## Impact

Affected code: `evals/harbor/run.mjs`, `normalize-results.mjs`,
`aggregate-results.mjs`, `corpus-selection.mjs`, a new
`evals/harbor/corpora/forgekit-campaign-v1.json`, a new task tree under
`evals/harbor/tasks/forgekit-campaign-v1/`, a new smoke entry point, and
`evals/README.md`.

Risks:

- **Reward schema change touches the existing corpora.** Normalization must
  keep accepting hard-v2's current rewards unchanged; the v1 lock test must
  still pass byte-for-byte.
- **Episode state carryover is a new failure surface.** A broken carry step
  silently turns episode N into a fresh start, which would look like a result.
  Carryover needs its own verification, not just a passing episode.
- **The corpus is public**, like hard-v2, so contamination cannot be excluded.
- **The effect may not appear.** Six episodes may be too few for compounding to
  become visible, and episode 3's contradiction may be plain enough that both
  arms catch it. Both are accepted design risks, recorded in the session's
  `brainstorm/decisions.md`.

Running the corpus is a separate, separately-authorized, billable act: roughly
$38 and 4 hours for 6 episodes x 2 arms x 2 repetitions at concurrency 1.
Building the corpus produces no effectiveness evidence by itself.
