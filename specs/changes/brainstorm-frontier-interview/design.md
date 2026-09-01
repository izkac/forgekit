# Design — frontier-round interview

## Context

`skills/forge/skills/brainstorming/SKILL.md` is a fork of an older obra/superpowers
brainstorming skill. This change swaps its interview engine for the frontier-round
model from mattpocock/skills' `grilling` primitive (MIT), keeping everything else
(hard gate, anti-pattern section, scope decomposition, 2–3 approaches, sectional
design presentation, spec self-review, user review gate, visual questions, terminal
state = plan-engine propose).

## Decisions

1. **Design tree + frontier rounds.** The interview models the design as a decision
   tree. The frontier = every question whose prerequisites are settled. Ask the whole
   frontier in one round, numbered, `❓ **Qn** - **title**: body` followed by
   `➡️ recommended answer`, separated by `---`. Questions depending on an open
   question in the same round wait for a later round. Alternative considered:
   keeping one-question-at-a-time with a dependency hint — rejected, round-trips
   dominate brainstorm latency.
2. **Facts vs decisions.** Facts (answerable from codebase/docs/environment) are
   never asked of the user: look them up or dispatch an exploration subagent,
   non-blocking — only downstream questions wait. Decisions always go to the user.
3. **Fast path.** At the first round, tell the user once they may reply
   "all recommended" (or answer selectively). This is how a pre-approved design
   collapses the interview to near-zero.
4. **Ledger + termination.** Keep an open-questions/assumptions ledger in the session
   `brainstorm/notes.md` during the interview. The interview ends only when the
   frontier is empty AND each ledger entry is answered or promoted to an explicit
   assumption. The design doc carries a `## Assumptions` section the user reviews;
   spec self-review gains check 5: any default not listed there is a defect.
5. **Pace mapping** (names unchanged, meanings sharpened): full = rounds until
   empty; short = cap ~2 rounds, remaining branches folded into recommended-answer
   assumptions; minimal = at most one round confirming intent.

## Risks

Instruction drift between the three files (SKILL.md, phases/brainstorm.md,
references/pace.md) — mitigated by a consistency-sweep task grepping for the retired
"one question at a time" phrasing.
