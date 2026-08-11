# Design — recalibrate triage and review cadence

## Context

Three problems, one root cause: Forge decides how much ceremony to spend at the
moment it knows least, and never revisits the decision.

Prompt-time triage sees a sentence. It does not see how many files the change
will touch, how many tasks it will produce, which capabilities it crosses, or
whether it wires a runtime seam. The documented response to that uncertainty is
to err toward Forge, which is defensible in isolation but becomes permanent
because nothing downstream can lower the setting.

## Decisions

### D1 — Fix the skip gate rather than tune the classifier

**Chosen:** `ALL` → `ANY` in `references/substantial-work.md`, delete the
closing line that re-requires explicit opt-out, and widen `isTrivialEdit` to
match the corrected doc.

**Alternative:** better prompt heuristics.

The gate is not badly tuned, it is logically closed. The three skip conditions
are mutually exclusive in practice, so no amount of classifier work reaches
them. Fixing the boolean is a smaller change with a larger effect.

`isSubstantialWork` keeps erring toward Forge for anything not clearly trivial.
The point is to make the trivial path reachable, not to make the gate
permissive.

### D1b — The agent decides; the filter only suppresses

**Added mid-implement, on user direction.**

**Chosen:** the prompt-time filter stops deciding whether work is substantial.
It decides one thing only — whether to *ask* the agent — and it suppresses just
the prompts that carry no work content: empty, `/forge:skip`, bare
conversational replies, read-only questions, stated trivial edits. Everything
else reaches the agent as a question, not a verdict.

**Alternative considered:** keep tuning the regex (what D1 assumed), or remove
the gate entirely and ask on every prompt including "thanks".

The hook shells out to `forge triage --check` and uses its **exit code as a
gate**: when the regex says no, the agent never learns the prompt existed. So
the regex was not advising the decision, it was making it — ahead of the only
component in the loop that can read the conversation, the repository and the
session state. Two agents spent a full review round tuning that regex against
`continue` and `thanks!`, which is the tell: they were approximating judgment
with pattern matching.

Suppression is the part that genuinely needs no judgment. Deciding that
"thanks" is not a feature request costs nothing and saves a reminder on every
conversational turn; deciding that "Please handle the onboarding thing" is or
is not substantial needs context the regex will never have.

**What this does not fix.** The agent's verdict is not recorded anywhere, so
"87 sessions, 0 skipped" still cannot become a number that moves — the count
D2 wants remains unavailable at prompt time. Recording it (`forge triage
--decide <verdict> --reason`) was offered and deliberately not taken in this
change. Tracked as a finding.

### D2 — Move the load-bearing triage decision to plan time

**Chosen:** keep the prompt-time filter as a cheap first pass; add an exit ramp
after brainstorm, once the work is shaped.

At that moment the shape is known: how many tasks, how many capabilities,
whether any spine row is wired, whether it touches high-risk surface. That is
the same evidence `plan-facts.mjs` already uses to resolve
`resolvedCeremony: combined` — the one place in the system that makes this call
well. The exit ramp generalizes it one step further: not just a lighter tail,
but the option to leave Forge entirely rather than write a proposal, design,
tasks, spine and brief for a two-file edit.

The ramp offers; it does not decide silently. Leaving Forge is recorded on the
session (`phase: skipped` with the resolved shape as the reason), so the
decision is auditable and countable — today's "87 sessions, 0 skipped" becomes
a number that can move.

### D3 — Thorough keeps its name, loses its cadence claim

**Chosen:**

| Pace | perTask | final | depth | maxRounds |
| --- | --- | --- | --- | --- |
| lite | never | **always** | spec-only | **1** |
| brisk | **never** | **always** | spec-only | 1 |
| standard | per-group | always | full | 2 |
| thorough | **per-group** | always | full | 3 |

**Alternative:** delete the thorough preset entirely.

Thorough currently spends 0.36 independent reviews per task against standard's
0.13, and returns 4.7 rejections per 100 tasks against standard's 4.8. The
cadence claim is unsupported. Depth and fix rounds are a different axis and
remain useful on genuinely risky work, so the preset survives with a narrower
meaning: deeper reviews and more rounds, not more reviews.

Two deliberate inversions of today's behaviour:

**lite and brisk gain the final review.** Today they skip it and keep per-task
for high-risk only. One reviewer reading the whole change is the cheapest
high-value dispatch in the system; N reviewers each reading a slice is the
expensive one that shows no measured return. Getting this backwards is the
single biggest mispricing in the current matrix.

**lite's `maxRounds` goes 0 → 1.** A final review with zero rounds cannot ask
for a fix, which would make lite's new review advisory-only — the exact
"advice decays" failure this project argues against.

The high-risk hard floor does not move. Money, auth, shared contracts,
migrations and secrets keep an immediate per-task review at every pace. It is
the one cadence rule with a strong external evidence base, and it is orthogonal
to the volume question this change settles.

### D4 — Pace resolution becomes two-way

**Chosen:** plan-time evidence may lower the resolved pace as well as raise it,
using the signals escalation already uses. A user-pinned pace is never
overridden in either direction.

`set-phase.mjs:173` escalates brisk/lite to standard at ≥15 tasks. There is no
inverse anywhere, which is the mechanical reason a session that starts strict
stays strict. Symmetry costs little: the evidence and the code path already
exist.

The asymmetry that stays: a pin is an explicit human instruction and auto
resolution is not, so `forge prefs thorough` still wins over any signal.

`score.mjs:578` currently expects escalation and will fail sessions that
legitimately de-escalate. Scoring moves with the rules in the same change, not
after it.

### D5 — Set the bar before moving the ceremony

**Chosen:** record the pre-change per-pace yield table in this change
directory, add the same table to `forge analyze`, and hold the change to
"rejections per 100 tasks must not fall".

Changing review ceremony on judgement is the thing this project's own research
argues against. The data already exists in `sessions.jsonl`; the only missing
piece is a command that prints it, so the check after 20 more sessions is one
invocation rather than a fresh ad-hoc script.

## What this does not fix

Rejection count measures problems **found**. A problem nobody looked for
produces no rejection, so the guardrail can detect ceremony that was wasted but
not ceremony that was needed. Testing the other direction needs defects traced
back to the pace of the session that introduced them, which requires the
findings ledger to carry an originating session id. Out of scope; recorded as a
follow-up.

## Risks

- Skill doc changes only take effect on other machines after
  `forgekit install --skills forge --force`.
- The 87-session base mixes three projects and two pace-matrix revisions, so
  magnitudes are indicative and the direction is what is being acted on.
- Every behavioural change here is a preset value or a resolution rule, so
  reverting is cheap and, with the recorded baseline, measurable.
