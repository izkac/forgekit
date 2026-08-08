# Plan — close the gaps the scorecard keeps finding

**Status:** Proposed 2026-08-07. Nothing started.
**Created:** 2026-08-07
**Owner:** whoever picks it up next — this document is the brief; follow it in order.
**Source:** helm `.forge/reports/analysis-2026-08-07.md` (34 scored sessions,
2026-07-28 → 2026-08-06), cross-checked against forgekit 0.3.37 source.

---

## Why this exists

The helm ledger's grade distribution is **16 C / 9 B / 9 A**, and almost none of
the C is content. Uncapped, the same work reads roughly 3 C / 12 B / 19 A. The
scorecard is doing its job — it keeps finding the same process failures — but
the toolkit only *grades* them after the fact; nothing surfaces or blocks them
while the session can still act. The 07-31 analysis report recommended fixes for
the two biggest recurring deductions. Both kept costing points on nearly every
session for the following week, because a recommendation in a report is not a
gate. This plan is the translation.

What the data shows (all reproducible from helm's `.forge/scorecards.jsonl` and
`forge analyze --json`):

| Measurement | Value |
| --- | --- |
| Sessions capped to 69 for a missing/self-authored final review | **13 of 34** (content scores 79–98 erased) |
| Of those, capped *after* the 0.3.36/0.3.37 done-gate existed and forge 0.3.37 was installed | 10 (2026-08-01 → 08-04) |
| Sessions scoring product_loop **0/20** ("no executed green e2e run, no product-loop section") | 3 — the three most recent, all small bug-fix changes |
| Sessions deducting 8–13 on product_loop for a missing baseline-diff assertion | ~15, continuing after the 07-31 report named it |
| Sessions losing 4–6 on tasks for "no task dirs" / tier-2 evidence in wrong place | 7+, continuing through 08-06 |
| Sessions whose metrics collection failed | **27 of 34** — every aggregate describes a 21% subset |
| `--allow-incomplete` uses, integrity failures, unresolved deferrals | 0, 0, 0 — the hard gates work |
| Sessions since 08-05 with an independent final review | all — the habit fixed itself, a week and 13 caps late |

The pattern across every row: **advice decays, gates hold.** Integrity and
deferral hygiene — the two things `forge phase done` actually blocks on — are
spotless across all 34 sessions. Everything enforced only by skill-doc prose
(baseline-diff steps, task-dir layout, group-review cadence, product-loop
sections on bug fixes) decayed within days of being written down. The work
below moves the recurring ones across that line, cheapest first.

---

## W1 — Pre-score advisory at `phase done`: no deduction is a surprise

**Problem.** Every capped or deducted session discovered its grade *after* the
transition, when the evidence trail was already frozen. Three of the failure
modes below (product loop, task dirs, review coverage) would likely self-correct
if the orchestrator saw the pending deductions while it could still fix them —
each was one command or one dispatch away from recovery.

**Change.** `score.mjs` already computes deductions and caps from the session
dir; it just runs too late. Add a preview path — `forge score --preview` (no
scorecard write, no ledger line) — and call it advisorily from `set-phase.mjs`
on `finish`/`done`, printing the deductions and caps the scorecard *will* take:

```
[forge] Score preview: 73 (C)
  - product_loop 0/20 — no executed green e2e run and no product-loop section
  - tasks 6/10 — no task dirs yet
  - cap: high-risk with self-authored final review → 69
Proceed anyway, or fix and re-run `forge phase done`.
```

Advisory, not blocking — the hard floors below stay separate. Telemetry-shaped
failure rule applies as everywhere in `set-phase.mjs`: a preview that cannot be
computed warns and never costs the transition.

**Acceptance.** A session about to lose points prints the exact deduction list
before the transition; a clean session prints one line; preview failure does not
block `phase done`. Test against fixtures for each deduction class.

## W2 — Product-loop floor: run it, or say why not

**Problem.** The three most recent helm sessions (all bug-fix changes: F60, F65,
F66) carry the strongest verify evidence in the ledger — orchestrator-re-run
gates, mutation-tested reviewer claims — and all scored **0/20** on product_loop.
The phase-change workflow always ran `forge e2e run` because plan docs make
`e2e.json` a plan deliverable; the bug-fix workflow that evolved in early August
inherits no `e2e.json` and nothing at verify or done time asks the question.
`verify.md` already says "prose no longer satisfies the done gate" — but only
the scorer ever checks.

**Change.** Two parts, mirroring the shape of the final-review floor:

1. In `set-phase.mjs`, at `finish`/`done`: when the plan has spine rows (or a
   standing repo harness is recorded per ADR 0001) and the session dir has no
   green `e2e-results.json`, refuse with the same declare-or-block contract the
   final-review floor uses — remedy first, waiver second:
   `--product-loop-waived "<reason>"`, recorded on the session and in
   `sessions.jsonl`, surviving cleanup in the digest. The scorer maps a waiver
   to a reduced-but-nonzero product_loop score with the reason quoted, instead
   of the silent 0/20.
2. In `skills/forge/phases/verify.md`, add the bug-fix case explicitly: a
   direct/fix change either re-runs the standing harness (`forge e2e run`
   against the repo's recorded `e2e.json`) or writes a product-loop section
   naming the nearest executed proxy and waives at done. One paragraph; the
   gate is what makes it hold.

**Acceptance.** A fix-shaped session with no e2e run cannot pass `done`
silently; a green run or an explicit recorded waiver both pass; the waiver
reason appears in the scorecard notes. The three helm sessions' shapes become
regression fixtures.

## W3 — Baseline-diff becomes an e2e lint, not a scorecard surprise

**Problem.** "Missing baseline-diff / ratify-changes-output assertion" is the
single most recurring deduction (~15 sessions, 8–13 points each). The guidance
exists in `verify.md` and both plan-phase docs; the 07-31 report's top action
was exactly this. It kept happening, because the first time anything checks the
step list is at scoring time.

**Change.** Add `forge e2e lint` in `e2e.mjs`: a static check that the step
list contains at least one step asserting a domain artifact changed against a
baseline (the same heuristic the scorer already applies — reuse, don't
duplicate; extract the classifier so scorer and lint share it). Wire it:

- into `forge e2e init` output ("scaffolded — lint says: no baseline-diff step
  yet"),
- into the plan checkpoint path so a spine-backed plan whose `e2e.json` fails
  lint warns before implement starts,
- into the W1 preview, where it already surfaces as the pending deduction.

**Acceptance.** An `e2e.json` of pass/fail-only steps fails lint with a message
naming what a qualifying step looks like; the scorer and lint agree on the same
fixture corpus (one shared classifier, tested once).

## W4 — Diagnose the final-review floor's blind spot, then pin it

**Problem.** The money/auth final-review floor (`enforceFinalReviewFloor`,
`set-phase.mjs`) and the scorer's high-risk cap read the same
`planFacts.highRisk`. Yet ten helm sessions were capped 2026-08-01 → 08-04 —
with forge 0.3.37 installed — and the done gate evidently never fired on any of
them. The two readers run at different times: the gate at `phase done`, the
scorer at `scoredAt`. Leading hypothesis: by `done` the change dir is archived
or moved (helm archives before closing), `collectPlanFacts` finds `changeDir`
unreadable, returns `highRisk: false`, and the floor silently passes — while
the scorer later resolves the archived change and reads `highRisk: true`. The
`readable: false → fail closed to standard` rule exists for pace but not for
the floor.

**Change.** Diagnose first — replay one capped session's `session.json` and
change-dir state against `collectPlanFacts` at its `done` timestamp; confirm or
kill the hypothesis before touching code. Then, whichever branch holds:

- if plan facts were unreadable at `done`: the floor fails closed — an
  unreadable plan on a `thorough` session warns loudly and evaluates the floor
  from the archived change dir (the scorer already knows how to resolve it), or
  refuses with the usual remedy/waiver pair;
- if something else: pin that instead.

Either way, add the regression test 0.3.36's cap work implies but does not
have: *gate and cap must agree on the same session state* — no session state
may produce "gate passed, cap fired" for the same reason code.

**Acceptance.** The replayed capped-session fixture now either blocks at `done`
or records a waiver; a property-style test asserts gate/cap agreement across
the fixture corpus.

## W5 — Group-review cadence: make the census visible mid-implement

**Problem.** "0 self-check(s), no dispatched reviewer" recurs whenever nothing
enforces cadence; it cost phase-7-ii-config-ui a soft cap (97 → 89) — a
626M-token session graded B for skipping per-group reviewers its sibling
session dispatched (and scored 100). The 0.3.36 cap table is right; it is also
the first time anyone hears about it.

**Change.** `forge status` (and the session-start reminder) shows the running
review census during implement: groups completed vs groups with a dispatched
independent review, and the cap that ratio currently implies — the same
`reviewCensus` the scorer reads, computed live. One line in `implement.md`
stating the default: one dispatched reviewer per completed task group on
standard/thorough, before the next group starts. No new gate — W1's preview
plus visible drift covers enforcement pressure; escalate to a floor only if the
next analysis still shows decay.

**Acceptance.** Mid-implement `forge status` on a fixture with 3 groups done
and 1 reviewed shows the shortfall and the pending cap; scorer and status agree
on the census.

## W6 — Tier-2 evidence lands where the scorer reads, mechanically

**Problem.** "No task dirs yet" with all tasks complete persists through
2026-08-06 (4–6 points, 7+ sessions) — the 07-31 report's action #2, unadopted.
Evidence exists; it sits in a flat `evidence/` folder the scorer doesn't read.
This is a layout convention enforced by memory.

**Change.** `forge record-evidence` becomes the one obvious path: given a task
id, it stamps `test-evidence.md` under the task dir the scorer reads, and its
`--help`/skill docs say so as the *only* documented destination. The W1 preview
names the deduction when tasks are complete but task dirs are absent, with the
exact command as the remedy line. No gate — with the preview naming the fix,
this either self-corrects or the next analysis says so.

**Acceptance.** A fixture session with complete tasks and flat evidence gets a
preview line naming `forge record-evidence --task <id>`; running it moves the
scorecard from "no task dirs" to tier-2 coverage.

## W7 — Metrics collection stops being all-or-nothing at `done`

**Problem.** 27 of 34 helm sessions have `collectionFailed` — the entire
phase-3b → phase-6 run is dark, so every cost figure describes a 21% subset.
ADR 0003 reads host transcripts, hosts prune them in days, and collection runs
once at `done`: a long session, a late `done`, or one bad pass loses the whole
session's telemetry permanently. Sessions since 08-05 collect fine, which
suggests recent freeze/keep work already narrowed it — but nothing proves the
gap has a known cause.

**Change.** Two parts:

1. Collect incrementally: `forge checkpoint` snapshots metrics the same way
   `done` does (`kept` merge semantics already exist in `writeMetrics`), so a
   pruned transcript costs the tail of a session, not all of it.
2. `forge doctor` gains a telemetry check: host transcript dir readable,
   last-session collection status, and — once — a dated post-mortem note in
   this plan for the 27-session gap after inspecting two failed sessions'
   `metrics.json` remnants. If the cause is already fixed, say which release
   fixed it and close the item.

**Acceptance.** A session checkpointed mid-way retains metrics for the
checkpointed span after its transcript is deleted; `forge doctor` reports
telemetry health; the gap has a written cause.

## W8 — Until the gates ship: thin checklist lines in consuming repos

**Problem.** W1–W7 take releases; helm sessions run daily against whatever is
installed. The lesson of the week is that skill-doc prose decays — but a
*short* rule at the point of action decays slower than a report nobody re-reads.

**Change.** In helm's `.claude/rules/forge.md` (and the forge skill's
`finish.md` until the floors land), three lines under a "before `phase done`"
heading: green `forge e2e run` or a written product-loop waiver; independent
final review dispatched or `--final-review-waived`; scorecard preview (once W1
ships — until then, `forge score` dry-read) shows no surprise deductions.
Remove the lines as the corresponding floors ship, so the rule file never
duplicates a gate.

**Acceptance.** The rules file carries the three lines now and sheds each one
in the release that automates it.

---

## Ordering and expected lift

W1 first — it is the smallest change with leverage over four failure modes and
makes every later floor's refusal message familiar before it blocks anything.
W2 next: it converts the only *active* regression (three straight C-77/73
sessions) at +16–20 points per fix-shaped session. W3–W4 close the two
recurring cap/deduction machines. W5–W7 are visibility and telemetry. W8 is
same-day and independent.

The 07-31 report's post-script is the acceptance test for this plan as a whole:
its advice was correct and changed nothing. If the next `forge analyze` window
still shows any of these deduction classes recurring, the corresponding item
here graduates from advisory to floor.
