# Forge cost and speed — plan

**Date:** 2026-08-10
**Status:** phases A–C landed; combined close landed, then recalibrated after cohort 3
showed its gate never fired (threshold + negation false-positive). Cohort 4 pending.
Outcome deltas at n=2 are inside the measured noise band — request counts are the
only legible metric. D still blocked; item 7 not started
**Owner:** Forgekit maintainers

## The problem, in numbers

The sonnet benchmark run (`forgekit-hard-v2`, 4 tasks, 2 arms) measured Forge against a
plain agent run on the same tasks:

| Measure | Forge vs baseline |
| ------- | ----------------- |
| Wall clock | ~2.9× |
| Input tokens | ~8.5× |
| Cost per trial | ~5.4× |
| Outcome | 6/8 vs 6/8 — a tie on that corpus |

A tie on outcome at 5.4× the price is not a trade anyone wants. The corpus had almost no
headroom (3 of 4 tasks at ceiling for both arms), so it cannot show Forge's upside — but
the cost side is real and measured, and it is the same on every corpus.

## Where the money actually goes

**The 8.5× is input tokens, not review essays.** Review verdicts are output tokens and a
small share of the bill. Input tokens get paid on:

1. **Every subagent cold start.** A 12-task change dispatches ~12 implementers plus
   reviewers. Each one starts with no context and re-reads the spec, the skill prose, and
   whatever repo files it needs. That ramp-up is paid once per dispatch, not once per
   session.
2. **Reviewers exploring the repo** instead of reading a diff.
3. **Coordinator prose.** `implement.md` alone was 342 lines (269 after item 5); the skill tree is ~2,240 lines
   plus ~870 lines of bundled skills. Some of it is read every session, some is copied into
   every brief.
4. **Full-workspace test runs** — the wall-clock half of the problem, not the token half.

So the ranking is: **fewer dispatches** > **smaller context per dispatch** > **less
ceremony**. Cutting reviews alone only touches the third item.

## Principles

- Keep every **integrity** gate. Spine, e2e, TDD evidence, no-stub rules, and the
  money/auth/contracts review floor are what Forge is for. None of them are on the table.
- Cut **repetition**, not rigor. The same file read by eight subagents is waste; the same
  file read once is not.
- Prefer changes that are **measurable** on the eval harness, so we can prove the cut did
  not cost quality.

## Work items, in order

Ordered by expected token saving per unit of risk. Items 1–3 attack the 8.5× directly;
4–6 are follow-ups; 7–8 are separate bets.

### 1. Group-scoped implementer (biggest lever) — **done**

**What:** one implementer subagent per `tasks.md` group instead of one per task, when the
group's tasks are coupled (same files / same area). The subagent does the group's tasks in
sequence, keeping warm context and prompt-cache hits between them.

**Why:** a 4-task group goes from 4 cold starts to 1. Combined with per-group review, a
group costs 2 dispatches instead of ~8. This is the single biggest cut to the input-token
multiple.

**Where:** `skills/forge/phases/implement.md` (per-task loop → per-unit loop),
`skills/forge/skills/subagent-driven-development/SKILL.md` (generalize the existing
"batching" rules from *small mechanical tasks* to *coupled tasks in one group*),
`skills/forge/subagents/implementer-prompt.md` (accept a task list, one TDD cycle per task).

**Guardrails:** never group money/auth/contracts/migration tasks (existing rule, kept).
Each task in the group still gets its own red→green `forge tdd run` stamps, so the
evidence gate is unchanged. Group size capped so a failure does not lose a lot of work.

**Risk:** a long-running subagent's own context grows; a bad group loses more work on
retry. Mitigated by the cap and by keeping high-risk tasks 1:1.

### 2. Reviewers read a diff, not the repo — **done**

**What:** make `{DIFF_RANGE}` mandatory in reviewer packets, and tell reviewers to review
the diff plus named spec sections rather than exploring the tree.

**Why:** reviewer input cost drops from repo-sized to change-sized. `forge checkpoint
--range --last` already produces the right `reviewTarget`; today it is optional and easy
to skip, and a reviewer with no range re-reads everything.

**Where:** `skills/forge/subagents/task-reviewer-prompt.md`,
`skills/forge/subagents/final-reviewer-prompt.md`, `skills/forge/phases/review.md`,
`skills/forge/phases/implement.md` step 4.

**Guardrails:** reviewers may still open any file the diff touches or that the spec names —
the rule bans *undirected exploration*, not reading.

### 3. Stop escalating the whole session to `thorough` on one high-risk mention — **done**

**What:** a plan that mentions money/auth/contracts currently sets the **session** pace to
`thorough`, which means per-task review for *every* task — including the docs task. Change
`suggestPaceFromPlan` so a high-risk plan resolves to `standard` and relies on the existing
**per-task** hard floor to catch the actually-risky tasks.

**Why:** the floor already exists and is per-task (`shouldReviewTask` takes `signalText` /
`highRisk`). Whole-plan escalation is a blunt instrument that multiplies reviews across
tasks that carry no risk. This session itself resolved to `thorough` for exactly this
reason.

**Where:** `packages/cli/src/plan-facts.mjs` (`suggestPaceFromPlan`) **and**
`packages/cli/src/preferences.mjs` (`suggestPaceFromSignals`), plus their tests. Both
resolvers had to move together — the slug pass at `forge new` sets the pace that sticks
whenever the plan is unreadable at implement, so leaving one on `thorough` would have made
the two disagree about the same signal.

**Guardrails:** the hard floor is untouched — high-risk *tasks* still get an immediate
per-task review and the final review still runs. What changes is the low-risk tasks that
happen to share a change with them. `forge prefs thorough` still pins thorough.

**Note:** `isHighRiskText` itself is already carefully tuned against false positives (see
the comments in `preferences.mjs`); this item does not touch the regex.

### 4. Cheaper ceremony inside `standard`

**What:** adjust the `standard` preset in `packages/cli/src/preferences.defaults.json`:

| Knob | Now | Proposed |
| ---- | --- | -------- |
| `review.depth` | `full` | `spec-only` |
| `review.maxRounds` | 2 | 1 |
| `verify.tier3` | `full-workspace` | `affected-only` |

**Why:** `spec-only` cuts reviewer output without cutting the spec gate. A second
fix→re-review round rarely changes the verdict — escalating to the human is cheaper and
more honest. `affected-only` tier 3 is the main wall-clock item; the full suite still runs
in CI on push.

**Risk:** this is the item most likely to cost quality. It ships *after* 1–3 and gets its
own before/after eval run, and each knob can be reverted independently.

### 5. Slim the per-dispatch boilerplate — **done**

**What:** compress what every brief carries into a short hard-rules block; move the
narrative (the review-label forgery history in `implement.md`, ~120 lines) into a
reference the coordinator reads once, not something copied per dispatch.

**Why:** 3–5k tokens of prose × 20 dispatches is real money for zero quality. The rules
must survive; the stories behind them do not need to ride along.

**Where:** `skills/forge/phases/implement.md`, `skills/forge/subagents/*.md`,
new/expanded `skills/forge/references/`.

**Guardrails:** every rule keeps a home. This is a move, not a delete — the retrospective
prose is history worth keeping, just not in the hot path.

### 6. Smaller plan artifacts for mid-size changes — **done**

**What:** for changes under ~6 tasks with a single capability, `design.md` becomes
optional — `proposal.md` + `tasks.md` is the deliverable.

**Why:** the design doc is written once and re-read by every subagent, so it is paid many
times over. On a small change it rarely earns that.

**Where:** `skills/forge/phases/plan-specs.md`, `skills/forge/phases/plan-openspec.md`.

### 7. Parallel implementers for independent groups (wall clock only)

**What:** allow concurrent implementer dispatches across groups with disjoint file sets.

**Why:** attacks the 2.9× wall-clock directly. Does **not** cut cost.

**Risk:** the current rule "never dispatch implementers in parallel (conflicts)" exists for
a reason. Needs a file-overlap check, and probably git worktree isolation. Lowest
confidence item on this list — treat as a spike, not a commitment.

### 8. Combined close — one pass replaces verify + review on small changes — **done**

**What shipped** (narrower and better-targeted than the original "middle mode" idea,
because the phase-level metrics said the implement side was never the problem): Forge now
resolves **`resolvedCeremony`** (`combined` | `full`) from plan facts on the way into
implement. `combined` — ≤2 tasks, single capability, no wired spine rows, not high-risk —
replaces the separate verify and review phases with one **closer** subagent pass
(`phases/close.md` + `subagents/closer-prompt.md`): diff-read, evidence-ledger audit, one
tier-3 run, READY/NOT READY, dispatched under `forge review-label final` so all scoring
and floor machinery is unchanged. One fix round, then escalate. Target ~10–15 requests
against the ~50 measured.

**Evidence it targets the right thing:** per-trial `metrics.json` across both cohorts —
verify+review+done = 2–4M input tokens/trial; implement = 0.4–0.9M. The tail is the bill.

**Guardrails:** high-risk and spine-rowed changes can never resolve to `combined`
(resolver-enforced, one-way); no-plan sessions fail closed to `full` unless their own
declared facts qualify; `forge phase done` integrity gates identical on both paths.

**Not yet measured** — needs the same cohort rerun, read via per-phase request counts
(not token means, which one rework trial can swing at n=2).

## Order of work

| Phase | Items | Why this order |
| ----- | ----- | -------------- |
| **A** ✅ | 3 | Smallest, self-contained, CLI-only with tests. Stops the over-escalation immediately. |
| **B** ✅ | 1, 2 | The two biggest token cuts. Skill-prose changes, no CLI risk. |
| **C** ✅ | 5, 6 | Cleanup that gets easier once 1 and 2 have reshaped the loop. |
| **D** | 4 | Preset retune, last, so its effect is measurable against a settled baseline. **Blocked:** needs an eval run over A–C first — retuning `standard` before we can see what A–C bought would leave us unable to attribute a quality regression to either. |
| **E** | 7, 8 | Item 8 shipped as the combined close (see above) after phase metrics showed the tail, not implement, dominates small-task cost. Item 7 (parallel implementers) still a spike, still gated on measurement. |

## Measured result — phases A–C, sonnet-hard-v2 cohort, n=2/task/arm

Reran the exact cohort from "The problem, in numbers" (same seed
`sonnet-hard-v2-cohort-1`, same 4 tasks, same both-arms/2-repetitions schedule,
Sonnet) against a tarball built from this branch. Aggregated with
`evals/harbor/aggregate-results.mjs`.

**Outcome — real, clean win.** Forge's shippable rate was 5/8 before (losing to
baseline's 6/8, primary `mean_delta: -0.125`). It's 6/8 now — an exact tie with
baseline, `mean_delta: 0`. Forge no longer loses to the plain agent on this
corpus.

**Cost/speed — mixed, not the predicted win.** Pooled across all 4 tasks (n=8
pairs per arm):

| Measure | Before (forge arm) | After (forge arm) | Change |
| ------- | ------------------- | ------------------ | ------ |
| Wall clock (mean) | 813s | 835s | +2.6% |
| Input tokens (mean) | 5,730,316 | 6,093,859 | +6.3% |
| Cost (mean) | $2.841 | $2.722 | −4.2% |

Not the 40%+ input-token cut the plan targeted. Per-task it's a split result,
not a uniform flat line:

| Task | Wall clock | Input tokens | Cost |
| ---- | ---------- | ------------- | ---- |
| reservation-confirmation-race | −40% | −37% | −37% |
| tenant-signed-downloads | −2% | −13% | −33% |
| partial-refund-ledger-invariants | +21% | +22% | +23% |
| carrier-event-reconciliation | +64% | +62% | +34% |

**The mechanism itself is confirmed working.** Checked `session.json` directly
for the two money/auth trials (`partial-refund-ledger-invariants`): pre-change
both resolved `pace: thorough, reason: "high-risk signals..."`; post-change both
resolved `pace: standard, reason: "...— per-task review floor applies"`. Phase A
fires exactly as designed.

**Two things this run surfaced that the reasoning missed:**

1. **Phase B has no opportunity to pay off on this corpus.** Grouping only
   matters when a plan has multiple tasks to group. Most trials in both cohorts
   resolved `planType: "direct"` with `tasksTotal` 0–1 — a single-shot session,
   never touching `tasks.md` groups at all. The hard-v2 tasks are small enough,
   and the agent's own triage light enough, that the tracked-change flow phase B
   targets barely engages. The 8.5× multiple in the original benchmark came from
   *this specific corpus's* dispatch pattern, and it isn't the multi-task-group
   pattern phase B assumed.
2. **Within-trial rework dominates the noise floor at n=2.** The worst
   regression (`carrier-event-reconciliation`, +64% wall clock) traces to a
   session named `repair-carrier-event-reconciliation` — the agent restarted
   with a fresh direct session mid-trial, which roughly doubles cost on its own
   and has nothing to do with phases A–C. At 2 trials per arm per task, one
   reworked trial swings that task's mean by 50%+.

**Conclusion:** ship the outcome win, don't claim the cost win yet. The plan's
cost/speed reasoning was directionally right about *where* tokens go (dispatch
ramp-up) but wrong about *how often* this corpus creates the multi-dispatch
situation phase B targets. Before phase D: either grow this cohort's `n` past
where one rework cycle swings the mean, or read dispatch counts directly out of
`metrics.json` (`byPhase` request counts) instead of inferring them from total
tokens — that would separate "phase B didn't fire" from "phase B fired and it's
still noisy."

## Cohort 3 (combined close) — the treatment never fired

Third run, same seed and settings, tarball carrying the combined close: forge arm 4/8
shippable, $3.86/trial — worse on both axes. Root cause: `resolvedCeremony` came out
`full` in **all 8 trials**, so the cohort measured an inert treatment and its deltas are
run-to-run noise. Two real findings out of it:

1. **The n=2 noise band is at least 4/8–6/8 shippable and ~$2.7–$3.9.** Cohorts 2 and 3
   ran effectively identical treatments and landed on opposite ends. The cohort-2
   "outcome win" (5/8 → 6/8) is inside this band and should not be claimed. Only per-phase
   request counts are legible at this sample size.
2. **Two gate misses, both fixed with pinned tests:** the ≤2-task threshold never matched
   because agents split one-file bugfixes into 3–5 micro-tasks (now `COMBINED_TASKS = 5`,
   shared with the no-plan fallback); and a proposal *disclaiming* risk ("no persistence
   migration … no money/auth") tripped the keyword regex — in wording our own design-skip
   rule suggested (now: negation lines are dropped before the risk read, and the plan
   phases tell planners not to enumerate disclaimed risks).

## How we will know it worked

Before/after on the eval harness (`evals/harbor`), same corpus, same model, same task set:

- **Primary:** input tokens per trial and cost per trial — target at least a 40% cut versus
  today's Forge arm.
- **Guard:** outcome score must not drop. A cheaper Forge that fails tasks is a worse Forge.
- **Secondary:** wall clock per trial.
- **Local signal:** `forge analyze` per-phase token totals across sessions in this repo,
  before and after.

`forgekit-hard-v2` has known task-design gaps (the carrier ambiguity, the refund grader's
`node:test` shim) that make the outcome number noisy. Fix those before treating any outcome
delta as real — a cost win is readable on the current corpus, a quality regression is not.
