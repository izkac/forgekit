---
name: /forge:analyze
description: Forge — analyze recent sessions and write an improvement report
category: Workflow
tags: [workflow, forge, retrospective]
---

**Forge-owned command.** Read the evidence recent Forge sessions left behind and write an honest improvement report — what went well, what keeps going wrong, and what to change. The analysis is yours: look for patterns, not single events.

## 1. Gather

**Run `forge analyze --json` first.** It is the quantitative source: coverage, per-model and per-phase token totals, tool error rates, grade distribution and the model-policy skip rate, aggregated deterministically from the ledgers. Do not recompute any of it by hand — reading numbers out of session directories yourself is how a session that was cleaned up silently drops out of the average.

`--limit <n>` and `--since <date>` narrow the window when the user asks for one.

Then read for narrative context only:

- `.forge/scorecards.jsonl` — per-session deductions, caps and incomplete reasons. `forge analyze` reports the grades; the *reasons* live here.
- `.forge/sessions/*/` for sessions still on disk: `scorecard.md`, `verify-evidence.md`, `spec-verify.md`, `openspec-verify.md`, `reviews/final-review.md`, `deferrals.json`, `session.json`, `metrics.json`.

If `coverage.sessionsTotal` is 0, tell the user there is nothing to analyze yet and stop.

**State the coverage before any conclusion.** If `coverage.sessionsWithMetrics` is below `sessionsTotal`, every token, model and error figure describes only that subset — say so in the report rather than presenting a partial history as the whole one. Sessions that predate telemetry still count in grades, deductions and deferrals.

## 2. Analyze

Patterns worth hunting (not a checklist — follow what the data shows):

- **Recurring deductions** — the same check losing points across sessions is a process problem, not a session problem.
- **`--allow-incomplete` usage** — legitimate deferrals, or the gate being routinely dodged? Read the reasons.
- **Pace vs outcome** — do brisk/lite sessions score worse here? Are task-count escalations firing when they should?
- **Evidence honesty** — ceremony-only tests, evidence with non-zero exits, verify phases that re-ran nothing.
- **Deferrals** — raised vs resolved; anything raised repeatedly for the same area?
- **Grade trend** — improving, flat, or decaying over time?
- **Cost per outcome** — `byPhase` and `totals` against grades. A phase eating most of the tokens for no grade improvement is a process finding.
- **Model policy** — `dispatches.skipRate` is how often a dispatch had to be corrected or refused. Anything above zero means `forge resolve-model` is being skipped; zero *with no dispatches recorded at all* means the PreToolUse hook is not installed, which is a different finding entirely.
- **Delegation** — `subagentsDispatched` against session grade, and `byModel` rows: which models actually ran, and did the sessions they ran in go better?

For each pattern found: name the root cause and one concrete fix — a pace pref, a missing harness, a rule, a habit. No generic advice.

Numbers are evidence, not conclusions. A model with a worse error rate over three sessions is a hypothesis; say how confident the sample makes you.

## 3. Report

Write `.forge/reports/analysis-<YYYY-MM-DD>.md`:

- **TL;DR** — 3 bullets max
- **Coverage** — "N of M sessions carry metrics", stated before any aggregate
- **Trend table** — session · date · grade · tokens · subagents · top deduction
- **What's working** — keep doing
- **What's broken** — each item with its concrete fix
- **Next actions** — ranked, smallest-effective first

Then summarize the TL;DR to the user in chat.

Reference: `~/.agents/skills/forge/docs/forge.md`
