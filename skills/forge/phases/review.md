# Review phase

Per-task reviews happen inside [implement.md](./implement.md). This phase covers **final** review before finish.

Read and follow [../skills/requesting-code-review/SKILL.md](../skills/requesting-code-review/SKILL.md).

**Pace:** Check `review.final` via [../references/pace.md](../references/pace.md) / `forge status`. If pace skips final review and the session is not high-risk, write `.forge/sessions/<id>/reviews/final-review.md` with `SKIPPED (pace=…)` and proceed. High-risk sessions (money/auth/contracts/migrations) always get a final review (hard floor).

Otherwise dispatch the final reviewer using [../subagents/final-reviewer-prompt.md](../subagents/final-reviewer-prompt.md) (whole-session verdict; the reviewer applies the checklist from [code-reviewer.md](../skills/requesting-code-review/code-reviewer.md)).

**Fill `{DIFF_RANGE}` before you dispatch.** Run `forge checkpoint --range`
(without `--last`, so the base is `session.baseCommit` and the range covers the
whole session) and paste its `reviewTarget`. Without checkpoints, give
`git diff <baseCommit>` plus the untracked files from `git status` by name — a
diff never shows an untracked file, and new files are most of what a session
writes. A reviewer handed no range rebuilds one by reading the repository, which
is the single most expensive thing a review does and finds nothing the diff
wouldn't have. An unfilled placeholder comes back as `NEEDS_CONTEXT` and costs
you the whole dispatch.

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
`capable`; an unknown tier refuses the same way. It prints which session it
labelled, and on what basis, on stderr — read that line.

**Run the command rather than typing the string.** The trailing session id is
what makes the record *yours*: one conversation routinely hosts several Forge
sessions, and a mistyped id matches nothing — which is the failure that refuses
correct work. Running it also resolves the reviewer's model in-process and writes
a **dispatch stamp** to `.forge/sessions/<id>/reviews/dispatches.json`, which
survives host-transcript pruning that would erase the host's own record. That
in-process resolution does **not** replace the separate `forge resolve-model`
call you make for the Task tool's own `model` parameter.

`final` is the only unit the census reads, and it decides the money/auth floor,
the scorecard's 69-point ceiling for an unreviewed high-risk change, and the
durable ledger. A pace skip (above) is a legitimate reason not to dispatch a
final reviewer at all, and this gate does not override it.

**Label the final reviewer, or label nothing.** Group labels buy nothing —
measured, a session's verdict, score and digest come out identical with and
without them. What they *do* is tell Forge the convention is in use: once any
dispatch of yours carries a label, a missing `final` label reads as "no outside
reader", the file's wording is not consulted, and a high-risk change refuses at
`forge phase done`. Partial adoption is worse than none, and it fails silently.

**Wording decides only when there is no host record *and* no stamp** — a repo
that never ran the command for this unit, or a dispatch the host measured as
below the substance floor. In that case a coordinator-written final review with
no declaration records `independent`: it is silence, not evidence, that passes
the gate. That is why you declare it.

What the stamp proves, what it doesn't, and the disclosed over-credit direction:
[../references/review-labels.md](../references/review-labels.md).

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

**Model:** follow [../references/model-selection.md](../references/model-selection.md) — `forge resolve-model --tier capable` (or `standard`/`fast` when `models.bias` is `prefer-fast` and not high-risk; billing **`included`** by default). If `omitModel` is true, **omit** the Task `model` parameter entirely; otherwise pass `model` exactly. Do not use metered/API models unless the user explicitly requests them. Never pick a slug from the host’s available-models list.

<HARD-GATE>
Do NOT hand-pick a model slug for the final reviewer — not even "the most capable" from the host's model list. Resolver output only. On dispatch failure, re-resolve; do not substitute a slug yourself.
</HARD-GATE>

Save output to `.forge/sessions/<id>/reviews/final-review.md`.

```bash
forge phase review
```

Address Critical and Important findings before finish.

Then proceed to [finish.md](./finish.md).
