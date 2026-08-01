---
name: /forge:analyze
id: forge-analyze
category: Workflow
description: Forge — analyze recent sessions and write an improvement report
---

**Forge-owned command.** Read the evidence recent Forge sessions left behind and write an honest improvement report — what went well, what keeps going wrong, and what to change. The analysis is yours: look for patterns, not single events.

## 1. Gather

- `.forge/scorecards.jsonl` — durable one-line-per-session ledger (score, grade, deductions, caps, pace, incomplete reasons). Survives session cleanup; this is your history.
- `.forge/sessions/*/` for sessions still on disk: `scorecard.md`, `verify-evidence.md`, `reviews/final-review.md`, `deferrals.json`, `session.json`.

If both are empty, tell the user there is nothing to analyze yet and stop.

## 2. Analyze

Patterns worth hunting (not a checklist — follow what the data shows):

- **Recurring deductions** — the same check losing points across sessions is a process problem, not a session problem.
- **`--allow-incomplete` usage** — legitimate deferrals, or the gate being routinely dodged? Read the reasons.
- **Pace vs outcome** — do brisk/lite sessions score worse here? Are task-count escalations firing when they should?
- **Evidence honesty** — ceremony-only tests, evidence with non-zero exits, verify phases that re-ran nothing.
- **Deferrals** — raised vs resolved; anything raised repeatedly for the same area?
- **Grade trend** — improving, flat, or decaying over time?

For each pattern found: name the root cause and one concrete fix — a pace pref, a missing harness, a rule, a habit. No generic advice.

## 3. Report

Write `.forge/reports/analysis-<YYYY-MM-DD>.md`:

- **TL;DR** — 3 bullets max
- **Trend table** — session · date · grade · top deduction
- **What's working** — keep doing
- **What's broken** — each item with its concrete fix
- **Next actions** — ranked, smallest-effective first

Then summarize the TL;DR to the user in chat.

Reference: `~/.cursor/skills/forge/docs/forge.md`
