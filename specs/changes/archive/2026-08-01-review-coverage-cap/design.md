# Design — review coverage caps the grade

## Context

`score.mjs` already has three caps, and they share one idiom: **outcomes outrank
artifacts**, expressed as a ceiling rather than as points.

| Existing cap | Ceiling |
| ------------ | ------- |
| `incompleteReason` set | 59 |
| session health red (failing product loop) | 69 (`OUTCOME_CAP`) |
| high-risk change without an independent **final** review | 69 (`OUTCOME_CAP`) |

Review *coverage* — whether anyone was dispatched to read the work as it was
built — is scored only as points, and only 5 of them. This change adds the
fourth cap in the same idiom.

### What was measured before choosing

Two corpus measurements were run first, because this project's guardrail is
"never narrow a heuristic without a corpus measured first" and 0.3.25 shipped
without one. Full numbers in the session brainstorm notes.

1. **19 `tasks.md` files.** `##` headings hidden in a fenced block: 0/19.
   Non-group `##` headings: 1/19. F16's denominator defects are real but rare —
   and this design does not use the denominator at all.

2. **18 rows of `.forge/sessions.jsonl`.** `final: "independent"` holds for
   **16 of 18** sessions. Six sessions have zero independent per-group reviews;
   three of those graded A (94, 97, 90).

The second measurement is what rejected the design this change started from.

**A first simulation of that design read per-group counts out of scorecard
`deductions` and was wrong** — a session scoring 5/5 on reviews has no deduction
entry, so it parsed as zero-review, and four A-grade sessions were misread as
uncovered. It was caught only because the output (a 99/A session about to be
capped to 69) was implausible enough to force a re-check against the durable
digest. That is the same class of error — a variable that one path never
populates, read as if it had — that shipped 0.3.25. It is recorded here because
the lesson is the change's whole subject.

## Decisions

### D1 — Two tiers, both keyed on `census.independent`

- **Alternatives considered:**
  - *An independent final review lifts the cap entirely.* Measured against the
    corpus this fires on exactly one session (`specs-engine-parity`), which
    already scores 25/F for an unrelated reason — **zero grade changes across 18
    sessions**. Inert.
  - *Reweight instead of capping* (reviews 5 → 20 points, taken from
    spine/product-loop). No cliff, no denominator. Rejected: it departs from the
    established cap idiom above, and silently rebases every historical score,
    which makes the scorecard ledger's own trend line discontinuous.
- **Rationale:** an independent final reviewer reading the finished whole
  answers a *different question* than review cadence during implementation. It
  is real mitigation — hence 89 (B) rather than 69 (C) — but not a full excuse
  when per-group reviewers were prescribed and none were dispatched.

### D2 — Fires only where reviewers were prescribed, read from the knob

The cap fires only when the **effective `review.perTask` knob** is `always` or
`per-group`. `high-risk-only` and `never` never cap: capping a session for
obeying its own configuration is the failure class 0.3.24 shipped and 0.3.26
reverted.

**This shipped in development gated on `resolvedPace ∈ {thorough, standard}`,
and the independent final reviewer reproduced the over-fire it allows.**
`review.perTask` is an independently overridable knob
(`forge prefs -- --set review.perTask=never`, merged by
`resolveEffectivePreferences` from defaults, `.forge/preferences.local.json`
and `session.preferencesOverride`). With `never` at `standard` pace,
`shouldRunPerTaskReview` returns false — Forge told the coordinator to skip
per-group reviewers — and the session was capped anyway, with a message
asserting reviewers were prescribed.

Reasoning from the knob while implementing from the pace *looked* consistent
only because this decision's own text quoted the knob values. The presets make
the two agree by default (`thorough`→`always`, `standard`→`per-group`,
`brisk`→`high-risk-only`, `lite`→`never`), so every test and the whole corpus
passed; only a deliberate override separates them.

The resolution happens at the call site and the resolved value is passed in, so
`reviewCoverageCap` stays pure (D5). If preferences cannot be resolved the cap
does not fire — an absence is not a measurement, the same rule as the malformed
census in D1.

### D3 — A task floor of 5, not a group floor of 3

- **Alternative considered:** 0.3.25's `groups >= 3`.
- **Rationale:** task counting (`- [ ]` lines) does not depend on `##` heading
  parsing, so the cap is immune to F16 **by construction** rather than by
  hoping the denominator is right. `auto` pace also fails closed to `standard`
  on unrecognized scope, so a small change can reach `standard` without anyone
  judging it needed a reviewer; the floor keeps the cap off those. Measured:
  every corpus change below 5 tasks is a single-group edit where one final read
  is proportionate.

Source is `collectPlanFacts().tasks` when the plan is readable, else
`session.tasksTotal`.

### D4 — Reuse the merged census object, never re-measure

The cap reads the same `census` the high-risk cap reads (built at `score.mjs:514`, consumed at the caps block)
(live census with the frozen verdict layered over it). Re-measuring would let
the cap and the `forge phase done` gate reach different answers — the defect
shipped in 0.3.22, where a session the gate refused then scored uncapped, and
the one record that outlives cleanup stayed silent about the missing review.

### D5 — A pure function, not inline branches

`reviewCoverageCap({ census, perTaskReview, tasks })` returns
`{ cap, reason } | null` and touches no filesystem. 0.3.25's defect was only
reachable because the guard was spread across statements sharing a mutable
variable with the scoring path. A pure function with every input passed in has
no branch that can skip an assignment, and is directly unit-testable without
building a session directory.

### D6 — The softened tier is 89, because 79 is a C

The softened tier was specified as **79** through brainstorm, the delta spec,
both implementer briefs, the operator brief and the cap's own message — all of
which called it "a B". It is not. `gradeForScore` puts B at `>= 80`, so a 79
ceiling grades **C**: the same band as the harsh tier, making the softening
invisible in the only unit that matters. "Review depth cannot move a grade" is
the literal text of F13, so the fix for F13 had reproduced F13.

Every test asserted the *score* (`assert.equal(measured.score, 79)`) and none
asserted the *grade*, so the whole suite was green across the defect. It was
caught by replaying the corpus and printing grades beside scores.

89 is the value that states the tier's intent exactly: an independent final
review is real mitigation, so a B remains reachable — but it is not a full
excuse, so an A never is.

**The general lesson, worth more than the number:** when a threshold feeds a
banded output, pin the band. A test on the raw value passes for every wrong
value inside the same band. This is the third variant of one failure this change
has now hit — a measurement standing in for the thing actually being asserted —
after the `deductions` misread in brainstorm and the `planFacts.tasks` zero at
the call site.

## Risks / Trade-offs

- **Inherits F9's prose classification.** Per-group `independent` counts are
  read from prose by design (`review-census.mjs` scope note: widening the
  evidence path to them "would put every review artifact behind a gate decision
  for no gain"). A misread that **deflates** a real reviewer to a self-check now
  costs a grade where it previously cost 2 points. Accepted: a cap costs a grade
  and never a transition — 0.3.25's cap was reverted as "a penalty, not a
  refusal" — and the failure this subsystem has twice been reverted for is
  refusing correct work, which a cap cannot do.

- **Three historical sessions drop A→B.** Intended, and the whole measured point
  of the change. Not applied retroactively: `.forge/scorecards.jsonl` is
  rewritten only when a session is re-scored.

- **A cap that fires on 3 of 18 sessions is a stronger signal than 0.3.25's,
  which fired on the wrong ones.** The regression test that pins this is the
  monotonicity case: zero reviews must never outscore one review, on otherwise
  identical fixtures.

- **F14 interaction.** This adds a third entry to the `caps` array, which does
  not distinguish *applied* from *noted*. The new cap pushes a note only when it
  actually lowers the score, so it does not worsen F14; it does not fix it
  either.
