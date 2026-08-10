# Review labels, dispatch stamps, and attribution — why the rules are what they are

The rules themselves live where they are used: [phases/implement.md](../phases/implement.md)
(task and group reviews) and [phases/review.md](../phases/review.md) (the final
review hard gate). This file is the reasoning behind them — read it when a rule
looks arbitrary, when you are changing how review evidence is scored, or when a
gate refuses and you need to know what it actually measured.

It is deliberately **not** in the implement phase's own text. Every line there is
read once per session and copied, in effect, into the coordinator's working
context; the rules have to be there, the history does not.

## What `forge review-label final` records

Running the command does three things:

1. Prints the label on stdout — `forge-review final <session-id>`.
2. Resolves the reviewer's model in-process at the requested tier (`--tier`
   overrides the default `capable`) and reports it on stderr. This does **not**
   replace the separate `forge resolve-model` call for the Task tool's own
   `model` parameter.
3. Writes a **dispatch stamp** — unit, label, session id, timestamp, resolved
   model — to `.forge/sessions/<id>/reviews/dispatches.json`, and reports the
   stamp path on stderr.

The host records the description against the subagent it actually ran, and
`forge phase done` reads that record rather than the final review file's wording.

## Why the session id is load-bearing

Without it the join was "a review dispatch somewhere in this conversation while
this session was open" — and one Claude Code conversation routinely hosts several
Forge sessions, so a neighbour's reviewer was indistinguishable from yours. Three
review rounds each found a fresh way for that to pass a self-written review
through the money/auth floor.

A dispatch described in the old two-word form is not counted for anyone: Forge
reports that it cannot tell, and falls back to the review file's wording.

## Why the match is exact

`forge-review implement group 1` and `talk about forge-review implementation
details` both matched an earlier, looser rule, so an implementer dispatch and a
sentence of prose each manufactured evidence of a review that never happened.

This is also why the command exists rather than a documented string: a hand-typed
label is a silent miss, and a silent miss at this gate refuses correct work.

## What the stamp proves, and what it does not

The stamp lives in the session's own directory rather than the host's transcript,
so it outlives host-transcript pruning — Cursor, Codex, and a pruned Claude Code
transcript included — and `forge score` reads it back as the `recorded` grade
wherever the host itself cannot answer.

It proves a label was **issued**, not that a review **ran**. So it never outranks
the host's own record; it only stands in where the host has none.

An earlier version of the implement-phase text called the label the one field you
cannot fabricate. That was too strong, and this project has the proof: dispatching
is cheap, and a throwaway subagent carrying the label produced the same record,
carrying a change through the money/auth gate against a review file that said in
plain words that no subagent had read it.

Forge now also asks what the dispatch *did*: a unit whose busiest single dispatch
you did not stop made fewer than five requests certifies nothing, and the wording
decides instead. That ends the one-line forgery and nothing more — someone who
knows the floor can pad past it. Still a check on the honest, not a defence
against the deliberate.

A below-floor dispatch is the host having **measured** thin work, not an absent
record, so the stamp does not rescue it: the stamp only ever substitutes for a
record the host lost, never for work a reviewer didn't do.

## Why labelling a group reviewer arms a rule

A mislabelled dispatch "falls back to the file's wording — the safe direction"
only while **no** dispatch of yours carries a label. The moment one does — and
labelling your group reviews is exactly that — Forge treats the convention as in
use for this session. A missing `final` label then reads as *"no outside reader"*
rather than *"not adopted"*, the wording is not consulted, and `forge phase done`
refuses a high-risk change whose independent review exists.

That was reproduced against the session of the change that introduced it, which
had labelled eight group reviews and no final one. **Partial adoption is worse
than none.**

Measured: identical sessions with and without a labelled group reviewer produce a
verdict, score and digest line identical in every field that does not vary with
wall clock or path — `units` is read for `final` and nothing else.

So the safe orders are *label the final reviewer* (group labels then harmless) or
*label nothing*. "Label everything" is only safe while you never forget the one
that counts, and its failure is silent.

## The stamp's error direction, stated plainly

The stamp narrows one way the armed rule used to bite, and no more:

- A missing `final` bucket the host read from a **complete** binding is a
  measured negative and still refuses at `forge phase done`. No stamp overrides
  it — a label printed with no dispatch ever carrying it is not a review.
- A host-recorded **stop** (the operator declining the reviewer) is a fact about a
  dispatch that exists, not an absence, so no stamp overrides it either — on a
  partial binding or a complete one — provided the stop is on record in a
  surviving bound transcript.
- The session whose *older* host transcript has since been pruned and whose
  `final` bucket is **missing** (not stopped) used to be indistinguishable from
  the complete-binding case, and refused changes that genuinely had a labelled
  final reviewer. That is what the stamp recovers.
- The disclosed gap: a dispatch whose own transcript, stop included, is entirely
  pruned reads as a plain absence the stamp can recover. **Over-credit is this
  mechanism's accepted error direction**; refusing correct work is not.

## Attribution: why wording is the whole answer for task and group reviews

Host evidence is scoped to the **final** review only. A task or group review is
classified from its words even when the session has full host evidence including
that review's own dispatch.

The census infers independence from the *absence* of a declaration, so an
unrecognised phrasing scores as an outside reader you never had — and lands
permanently in `sessions.jsonl` and the fleet totals. Describing it in your own
words does not work; the phrase list is closed and lives in
[phases/implement.md](../phases/implement.md).

Placement is the other half. Put the phrase in the opening two paragraphs
(blank-line separated, any length). Below that, only a line beginning `Reviewer:`
is reliably read, and it still has to carry one of the closed phrases:
`Reviewer: coordinator` scores `self` wherever it sits, `Reviewed by: coordinator`
does not. A `self-check` in a *Process* section at the foot of the file scores
**independent** and passes the floor.
