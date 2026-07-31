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
the `--session <id>` that selects it; pass that flag when it asks. Pass `--tier
fast|standard|capable` to resolve the reviewer at a tier other than the default
`capable`; an unknown tier refuses the same way — before anything, label or
stamp, is written. It also prints which session it labelled, and on what basis,
on stderr — read that line. That string is how `forge phase done` knows an
outside reader saw this change; `final` is the only unit the census reads, and it
decides the money/auth floor, the scorecard's 69-point ceiling for an unreviewed
high-risk change, and the durable ledger.

**Running the command now does three things, not one.** It still prints the
label on stdout, byte-identical to before. It also resolves the reviewer's model
in-process at the requested tier — the same resolution [implement.md](./implement.md)'s
per-task loop uses `forge resolve-model` for — and reports the resolved model on
stderr. That in-process resolution is what the stamp below records; it does
**not** replace the separate `forge resolve-model` call you still make for the
Task tool's own `model` parameter — run that as prescribed and pass back what it
returns. Third, it writes a **dispatch stamp** — unit, label, session id,
timestamp, resolved model — to `.forge/sessions/<id>/reviews/dispatches.json`,
and reports the stamp path on stderr. The recorded model is informative only,
never load-bearing: the census reads a stamp's `unit` and session id, never
its `model`, so labelling at one tier and then dispatching the Task tool at
another `forge resolve-model` tier is harmless — the stamp records what
`review-label` itself resolved, not what the dispatch ran as, and the verdict
never depends on the two matching. A stamp write failure warns and never
blocks the label; no refusal path above (ambiguous session, bad unit, bad tier)
ever leaves a stamp. Because the stamp lives inside the session's own directory
rather than in the host's transcript, it survives host-transcript pruning that
would otherwise erase the record — Cursor, Codex and a pruned Claude Code
transcript included — and `forge score` reads it back as the `recorded` grade
when the host itself cannot answer. What it proves is narrower than it sounds: a
label was *issued* at dispatch time with a resolved model, not that a reviewer
*ran* — which is why `recorded` still ranks below the host's own record, and
why a well-formed dispatch the host measured as under the substance floor still
routes to this file's prose rather than to the stamp.

That gap is also where the mechanism's error direction shows. On a
**partial** binding, a dispatch whose own record — including any operator
stop — falls entirely inside the pruned half reads as a plain absence, and
the stamp can recover it as `recorded` the same way it recovers a reviewer
that genuinely ran, even where an intact record would have said `self`.
Over-credit is the accepted, disclosed direction here; refusing correct work
is not. A stop that **is** on record — visible in any surviving bound
transcript — is not this gap: it is a measured fact, not an absence, and no
stamp, on a partial binding or a complete one, ever overrides it. See
[implement.md](./implement.md) for the same boundary stated beside the
armed-rule case it protects.

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

**When there is no host record *and* no stamp, this review file's *wording*
decides the money/auth gate — and only then.** No host binding, Cursor,
Codex, and a transcript pruned in whole or in part used to fall straight to
the file's prose in every one of those cases. Now the stamp answers first if
`forge review-label final` was actually run for this session: it is written
into the session's own directory, not the host's, so none of those erase it,
and it grades `recorded` without the file ever being opened. Wording still
decides in the two cases the stamp can't reach: a repo that never ran the
command for this unit at all (a hand-typed label, a legacy session
predating this change, or a stamp write that failed — warned about on
stderr, never silent), and a dispatch the host itself *measured* and found
under the substance floor, which is a record of thin work rather than an
absent one and is deliberately left to prose — the stamp does not
substitute for work a reviewer didn't do. In that no-stamp, no-host case a
coordinator-written final review with no declaration still passes the
high-risk floor and records `independent` in the durable digest. Falling
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
