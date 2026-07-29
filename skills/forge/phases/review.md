# Review phase

Per-task reviews happen inside [implement.md](./implement.md). This phase covers **final** review before finish.

Read and follow [../skills/requesting-code-review/SKILL.md](../skills/requesting-code-review/SKILL.md).

**Pace:** Check `review.final` via [../references/pace.md](../references/pace.md) / `forge status`. If pace skips final review and the session is not high-risk, write `.forge/sessions/<id>/reviews/final-review.md` with `SKIPPED (pace=…)` and proceed. High-risk sessions (money/auth/contracts/migrations) always get a final review (hard floor).

Otherwise dispatch the final reviewer using [../subagents/final-reviewer-prompt.md](../subagents/final-reviewer-prompt.md) (whole-session verdict; the reviewer applies the checklist from [code-reviewer.md](../skills/requesting-code-review/code-reviewer.md)).

<HARD-GATE>
Take the label, and dispatch the final reviewer with the description **exactly**
what it prints — nothing before or after:

```bash
forge review-label final                # → forge-review final <session-id>
```

**It refuses rather than guessing.** If more than one session in the project is
unfinished, or it cannot read them, it exits non-zero and lists each candidate as
the `--session <id>` that selects it; pass that flag when it asks. It also prints
which session it labelled, and on what basis, on stderr — read that line. That string is how `forge phase done` knows an
outside reader saw this change; `final` is the only unit the census reads, and it
decides the money/auth floor, the scorecard's 69-point ceiling for an unreviewed
high-risk change, and the durable ledger.

**Run the command rather than typing the string.** The trailing session id is
what makes the record *yours*: one Claude Code conversation routinely hosts
several Forge sessions, and without the id a neighbour's reviewer is
indistinguishable from your own — which is how a self-written review passed the
money/auth floor at score 93 during this feature's own review. A mistyped id
matches nothing, and matching nothing is the failure that refuses correct work.

This applies whenever you dispatch a final reviewer at all — a pace skip (above)
is a legitimate reason not to, and this gate does not override it.

**Label the final reviewer. Group labels are optional and buy nothing** —
measured, a session's verdict, score and digest come out identical in every field
with and without them, because `final` is the only unit the census reads. What a
group label *does* do is tell Forge the convention is in use for this session:
once any dispatch of yours carries a `forge-review` label, a *missing* `final`
label reads as "no outside reader", not as "not adopted", and the file's wording
is not consulted. On a **high-risk** change that refuses at `forge phase done`;
on any other it records `{self, host}` in the durable digest for a session that
did get an independent reviewer.

So the safe orders are *label the final reviewer* (group labels then harmless) or
*label nothing*. "Label everything" is only safe while you never forget the one
that counts, and its failure is silent. Partial adoption is worse than none.

**When there is no host record, this review file's *wording* decides the
money/auth gate.** No binding, Cursor, Codex, a pruned transcript, or a repo that
labels nothing — in all of those `forge score` falls back to reading the file. So
a coordinator-written final review with no declaration passes the high-risk floor
and records `independent` in the durable digest. That is the common case today,
and for a session that never touched Claude Code it is the only case. Falling
back is not a substitute for labelling: the fallback's default answer is
*independent*, so it is silence, not evidence, that passes the gate.

**If you wrote the final review yourself, declare it with one of these exact
phrases — the list is closed — and put it in the opening two paragraphs or on a
line beginning `Reviewer:`:**

> `self-check` · `self-review` · `self-audit` · `self-authored` ·
> `Reviewer: coordinator` · `reviewed by the coordinator` ·
> `APPROVED (pace …)` · `SKIPPED (pace …)`

**Saying it in your own words does not work.** Measured, every one of these scores
`independent` and passes the money/auth floor even as the first line of the file:
*"This review was written by the coordinator; no subagent was dispatched"*, *"I
wrote this final review myself"*, *"No subagent was dispatched"*, `Reviewer: me`,
`Reviewer: none — I wrote this myself`, and
`Reviewer: claude-opus-5 (coordinator) — no subagent ran`. After `Reviewer:` the
matcher wants `coordinator`, `the coordinator`, `author` or `myself` **next**;
anything else on that line is prose it does not read.

Placement is the other half, and the simple rule is the safe one: **put the
phrase in the opening two paragraphs** — blank-line separated, any number of
lines each. Below that, only a line beginning `Reviewer:` is reliably read, and
it still has to carry one of the phrases: `Reviewer: coordinator` scores `self`
wherever it sits, but `Reviewed by: coordinator` does not. A `self-check` in a
*Process* section at the foot of the file scores **independent** and passes the
floor.
</HARD-GATE>

**Model:** `forge resolve-model --tier capable` (or `standard`/`fast` when `models.bias` is `prefer-fast` and not high-risk; billing **`included`** by default). If `omitModel` is true, omit the Task `model` parameter; otherwise pass `model` exactly. Do not use metered/API models unless the user explicitly requests them.

<HARD-GATE>
Do NOT hand-pick a model slug for the final reviewer — not even "the most capable" from the host's model list. Resolver output only. On dispatch failure, re-resolve; do not substitute a slug yourself.
</HARD-GATE>

Save output to `.forge/sessions/<id>/reviews/final-review.md`.

```bash
forge phase review
```

Address Critical and Important findings before finish.

Then proceed to [finish.md](./finish.md).
