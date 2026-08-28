# Changelog

## Unreleased

## 0.3.51 — 2026-08-28

Specs leftover sweep before final review. When a session is `planType: specs`,
Forge verify always runs the bundled `specs-verify-change` skill (no vendor
CLI), fixes every finding (CRITICAL, WARNING, SUGGESTION — including files
`tasks.md` never listed), and records `spec-verify.md` with `Remaining: none`.
`forge phase review` and `forge phase done` refuse without it. OpenSpec still
uses `openspec-verify.md` when the vendor skill is present. Combined close
still runs the sweep before the closer.

Review cadence copy matches `implement.md`. `/forge:apply` and the OpenSpec
apply overlay dispatch one implementer per `tasks.md` `##` group and one
combined task reviewer at the group boundary. The session-start reminder and
pace reasons say the high-risk floor is each **task line**, not the change
name. `shouldRunPerTaskReview` ignores kebab slugs passed as `signalText`
(hmac/migrate in the slug no longer reviews every task).

## 0.3.50 — 2026-08-27

OpenSpec leftover sweep before final review. When `openspec-verify-change` /
`/opsx:verify` is in the project and the session is `planType: openspec`,
Forge verify runs that sweep, fixes every finding (CRITICAL, WARNING,
SUGGESTION — including files `tasks.md` never listed), and records
`openspec-verify.md` with `Remaining: none`. `forge phase review` and
`forge phase done` refuse without it. The vendor "ready for archive (with
noted improvements)" line is not enough. Specs-engine sessions skip the
gate. Combined close still runs the sweep before the closer.

## 0.3.49 — 2026-08-27

`forgekit install` no longer offers a selectable `agents` environment or a
`--shared` flag. Cursor, Codex, Copilot, Gemini, and OpenCode write skills
once to `~/.agents/skills/<skill>/`. Claude and Windsurf keep their vendor
paths. The first-run picker pre-checks the `.agents`-capable harnesses.
`--shared` errors with guidance to `--cursor` / `--codex`. `--agents agents`
is an unknown agent. Uninstall records which harnesses own a dest: uninstalling
Cursor keeps `~/.agents/skills/<skill>/` while Codex is still recorded, and
removes it when Cursor was the only owner.
`forge init --agents` still errors and points at `forgekit install`. A stamped
project copy at `.agents/skills/forge/` (from 0.3.48) is a `forge doctor`
warning (never a failure) naming `forge init`, and is deleted by the next
`forge init`; unstamped / other `.agents/` content is left alone. Stamped
leftovers at old vendor skill paths are retired on the next `.agents` install.

## 0.3.48 — 2026-08-27

Vendor-neutral `.agents` target, mirroring OpenSpec's `openspec init --tools
agents`: `forgekit install` gains an `agents` environment that installs skills
to `~/.agents/skills/<skill>/`, and `forge init --agents` copies the packaged
Forge skill into the project at `.agents/skills/forge/` (committed, so the repo
carries Forge for the team). The target is skills-only — no command files and no
hooks, which stay with the per-tool targets — and combines with the
cursor/claude/codex targets in the same run; in agnostic tools, invoke Forge by
name. `forge doctor` warns (not fails) when the project copy is outdated,
naming `forge init --agents` as the refresh.

## 0.3.47 — 2026-08-27

Fix: `/forge` over an already-proposed change (OpenSpec or specs) implemented
it inline — no session, no subagents, no reviews. The `/forge` command now
routes existing changes to the `/forge:apply` flow itself (session,
`forge phase implement`, subagent-driven TDD, verify, review), and the skill,
`substantial-work.md`, and thin rules carry the same rule: never implement an
already-proposed change inline. Also, invoking Forge by name now matches any
phrasing — "with Forge", "do forge work", "run the forge workflow", "start a
forge session" — not just "use Forge".

## 0.3.46 — 2026-08-27

Forge starts only when you type `/forge` or ask to **use Forge**. It no longer
auto-triages every chat request. After you invoke it, triage is still the first
step (tiny work can still skip the rest of the pipeline). Claude's per-prompt
auto-triage hook is retired; `forge init` / `forge doctor --install` unwire and
delete leftovers. Reinstall the skill (`forgekit install --skills forge --force`)
so agents pick up the new default.

## 0.3.45 — 2026-08-24

Docs: new `docs/day-to-day.md` — the operator's guide to Forge. Scenario-driven:
which commands are yours vs the agent's, the three ways to start work, a feature
walked start to finish, pace in "reach for it when" terms, gate refusals in
plain words, fleet, and the few options an operator actually touches. Linked
from the README and `docs/usage.md`; no code changes.

## 0.3.44 — 2026-08-13

Harbor evals: the Forge arm is told the trial is unattended (no operator, pick a
default, do not stop on a clarifying question). Campaign episodes are 1.1.0 with
a 3600s agent cap on both arms so a full Forge loop can finish. hard-v2 stays at
1200s. Next live campaign run is a new cohort.

## 0.3.39 — 2026-08-12

### The agent decides whether work needs Forge; the filter only suppresses

`forge triage --check` no longer decides substantiality. It decides one thing —
whether to *ask* — and suppresses only prompts carrying no work content: empty,
`/forge:skip`, a bare conversational reply, a read-only question, a stated
trivial edit. Everything else reaches the agent as a question. The reminder asks
("Decide: does this prompt need Forge?") where it used to assert ("Substantial
work detected"), and `hasWorkContent` replaces `isSubstantialWork` so no name in
the module claims a verdict the filter does not make.

The hook used the classifier's exit code as a gate, so a regex was making the
call ahead of the only component that can read the conversation, the repository
and the session. `references/substantial-work.md` is now criteria for a judge
rather than a specification the regex mirrors, and its skip conditions are
**ANY**, not **ALL** — three conditions that could not all hold at once are why
none of 87 recorded sessions was ever marked skipped.

Four review rounds went into the suppression list, and the honest result is
recorded as a finding rather than claimed as solved: a lexical filter cannot
draw this line. Substrings silenced "Add a changelog generator"; a creation-verb
gate silenced "Fix the double-charge bug ... this is a rename-only change to the
Stripe adapter"; a mechanism-noun gate silenced "Add a changelog digest
emailer". Each failure means no session, so the high-risk floor never engages.
`changelog` is gone from the markers entirely — a plain noun, unlike every other
marker, which assert something about an edit's nature — and `typo`,
`formatting-only` and `whitespace-only` are unconditional again. What remains
gated is a shorter list to delete from, not a longer one to refine.

### Review cadence is capped at per-group, and every preset ends with a review

Measured over 87 sessions in three projects: `thorough` spent 0.36 independent
reviews per task against `standard`'s 0.13, and returned 4.7 rejections per 100
tasks against 4.8. The cadence claim was unsupported.

| Knob | thorough | standard | brisk | lite |
| --- | --- | --- | --- | --- |
| review.perTask | per-group | per-group | never | never |
| review.final | always | always | always | always |
| review.maxRounds | 3 | 2 | 1 | 1 |

Two deliberate inversions: `lite` and `brisk` **gain** the final review, because
one reviewer reading the whole change is the cheapest high-value dispatch in the
system while N reviewers each reading a slice showed no measured return; and
`lite.maxRounds` goes 0 → 1, because a review that cannot ask for a fix is
advisory, which is the failure this project argues against everywhere else.

The high-risk floor does not move. Money, auth, shared contracts, migrations and
secrets still get an immediate per-task review at every pace.

`thorough` now differs from `standard` in `maxRounds` alone — `depth` is `full`
for both and always was. Whether a one-knob preset earns a name is filed for the
yield table below to settle, not decided on judgement.

### Pace movement is recorded, not just performed

Plan-time de-escalation has shipped since 0.3.17; an earlier draft of this
change asserted it did not exist and was corrected against the code. What was
missing is the record. `paceDeescalated` marks a downward move, derived from
comparing the pace before and after rather than from which function ran, since
plan resolution moves either way. `paceSuppressed` records what a user pin
overrode, and only when the signal would actually have differed — agreement is
not suppression. Both now reach `sessions.jsonl` instead of dying with the
session directory.

`forge score` reads the marker instead of inferring from a threshold
coincidence. That fixes a real misgrade: `forge status` heals `tasksTotal`
straight from `tasks.md` without re-running the escalation invariant, so a
session legitimately de-escalated at 3 tasks scored 0/5 "expected escalation to
standard" once its plan grew.

### A plan-time exit ramp, and skipped sessions that leave a record

After brainstorm the work is shaped, so `forge exit-check --tasks N
--capabilities N --spine-rows N [--high-risk]` decides whether to *offer*
leaving Forge before a proposal, design, tasks, spine and brief are written for
a two-file edit. Exit 0 offers, exit 1 proceeds. The agent supplies the counts —
it has just done the shaping — and Forge owns the rule and the record. It fails
closed on missing, non-numeric, negative, fractional, flag-shaped or repeated
values; zero tasks is unshaped work and never qualifies; high-risk never
qualifies however small.

Either answer is recorded: `forge phase skipped --exit-reason "<reason>"` or
`forge phase plan --exit-declined "<reason>"`. A skipped session now writes a
`sessions.jsonl` row at all — before, it wrote none, left the unfinished-session
view, and the next bare `forge cleanup` removed it with no durable record that it
ever existed. Its row carries `score` and `grade` as `null`, never `0`, so it
cannot drag an average.

### forge analyze reports review yield per pace

The measurement that justified this recalibration was done once, by hand, with a
throwaway script. It is now one command, computed the same way, so the check
after the next 20 sessions is an invocation rather than an archaeology project:
sessions, tasks, independent reviews, reviews per task, rejections, rejections
per 100 tasks. Figures come from recorded review stamps only —
`subagentsDispatched` is null for 2 of 87 rows and 0 for 22 more, and a
harvested zero cannot be told apart from a session that genuinely dispatched
nothing. A session whose telemetry harvest failed still contributes its recorded
reviews.

The pre-change baseline is checked in at
`specs/changes/recalibrate-triage-and-review/baseline-yield.md` so the effect is
comparable against a fixed reference rather than a recollection.

### Docs that cannot drift again

`pace.md` and the skill's full reference both carried the pre-change matrix, and
the full reference is the file `SKILL.md` tells agents to follow — an agent
obeying it ran per-task review under `thorough` and skipped the final review
under `lite`. Both are corrected, and `pace-doc-drift.test.mjs` now pins both
against the shipped defaults; either drifting fails the suite.

Also corrected: `auto` was described as resolving "once at session start, sticky
for the session" in three places. It has three resolution points — session start
from signals, plan-time re-resolution either direction, and task-count
escalation. And the `/forge` command templates still told agents to skip only on
an explicit `/forge:skip`, the exact rule this release removes.

**Skill doc changes reach other machines only after
`forgekit install --skills forge --force`.** `install.mjs` copies files rather
than symlinking them, so every machine keeps reading the old copy until it is
re-run.

## 0.3.38 — 2026-08-11

### Ceremony fails closed at the gate; closers carry attribution; task counts declared at implement

The three cohort-5 residual gaps, closed:

- A session that skips `forge phase implement` never resolved ceremony and was
  indistinguishable from `full` while following neither path. verify/done/finish
  now fail it closed to `full` and record why — the cheap tail is granted from
  plan facts at implement, never retroactively at a gate.
- `close.md`'s save step now owns the attribution check: a closer report that
  does not open with `Reviewer: <model> (closer)` gets the line prepended from
  the dispatch stamp before saving — all four cohort-5 final reviews were
  missing it and graded from silence.
- `implement.md` opens with the declaration requirement
  (`forge phase implement --tasks-total <N>`): pace and ceremony resolve from
  that transition, and two cohort-5 trials paid the full ceremony on small
  changes only because it was omitted.

### Combined close is now a rail, not a suggestion (cohort 4 follow-up)

Cohort 4 was the first where the recalibrated gate fired (3 of 8 forge trials
resolved `combined`; the refund trials correctly held `full` on the money
floor). Adoption of the path itself was 0 of 3: one session dispatched a
capable-tier final reviewer anyway — 90 tail requests, the cohort's most
expensive tail, on the trial marked for the cheap one — and two reached `done`
with empty `reviews/` directories. Prose routing is advisory; the agent's
momentum wins. Three CLI rails now enforce what close.md describes, each on a
surface every session actually crosses:

- **`forge phase verify`** prints the combined-close instructions imperatively
  on stderr at the transition — the moment the tail starts, not a line at the
  top of a file the agent may never re-read.
- **`forge review-label final`** on a combined session defaults the reviewer
  tier to `standard` and refuses an explicit `--tier capable` unless
  `--full-tail` asserts the choice; the refusal writes no stamp. `--tier fast`
  is never refused — over-spend is the failure this rail exists for.
- **`forge phase done`** refuses a combined session while
  `reviews/final-review.md` is missing: the closer *is* the final reviewer, so
  skipping it no longer slides through. `--allow-incomplete` remains the
  recorded escape hatch.

The cohort's headline numbers (forge 6/8 shippable — a tie with baseline —
$2.98/trial) are unchanged from the noise band; with 0/3 adoption they measure
momentum, not the treatment. Rails first, then measure again.

### Combined-close gate recalibrated after cohort 3 measured it never firing

The third sonnet-hard-v2 cohort ran with the combined close in the tarball and
it fired in **0 of 8** forge trials — the whole cohort measured an inert
treatment (its 4/8 shippable and higher cost are run-to-run noise, which also
means the n=2 noise band spans at least 4/8–6/8). Two distinct gate misses,
both fixed with pinned tests:

- **Task-count threshold 2 → 5** (`COMBINED_TASKS`, exported and shared with the
  no-plan fallback). Agents split even a one-file bugfix into 3–5 micro-tasks
  (red, green, full-suite as separate ticks), so ≤2 never matched. Task count is
  granularity, not size; capabilities and spine rows still gate.
- **Negated risk mentions no longer count.** A carrier-task proposal reading
  "Risk: low — no persistence migration … design.md skipped: … no money/auth" —
  wording our own design-skip rule suggested — tripped `isHighRiskText` and
  forced the full tail. `collectPlanFacts` now drops negation lines
  (`dropNegatedRiskLines`) before the risk read; affirmative mentions still
  escalate, and only lines are dropped, never documents. The plan-phase notes
  now also tell planners to word design-skip lines neutrally instead of
  enumerating the risks they disclaim.


### Risk raises the pace floor to `standard`, not `thorough` (cost/speed plan, phase A)

A plan mentioning money/auth/contracts/migrations used to set the whole session
to `thorough`, which means a per-task reviewer for **every** task — including the
docs and config tasks that carry no risk. Risk is a property of a task, and the
per-task hard floor (`shouldReviewTask`) already dispatches an immediate reviewer
for every high-risk task on every pace, so the escalation bought nothing for the
risky work and doubled the reviewer count around it. Measured on the hard-v2 eval
arm, whole-plan escalation was the common case.

Both resolvers now return `standard` on a high-risk signal —
`suggestPaceFromPlan` (plan text, at implement) and `suggestPaceFromSignals`
(slug, at `forge new`) — while still outranking `brisk`/`lite`, so a high-risk
change can never land on a pace that skips reviews. The `isHighRiskText` regex is
unchanged, as is the per-task floor. `forge prefs thorough` still pins thorough.

Plan: [docs/plans/2026-08-10-cost-and-speed.md](docs/plans/2026-08-10-cost-and-speed.md).

### One implementer per work unit, not per task (cost/speed plan, phase B)

The dispatch unit is now a **work unit** — by default one `tasks.md` group —
instead of one task. A subagent dispatch pays a full context ramp-up (spec,
constraints, files), and that ramp-up, not review output, is where Forge's ~8.5×
input-token multiple came from; a four-task group used to pay it four times.

Inside a unit nothing relaxes: one task at a time, its own red→green
`forge tdd run` stamps, its own `tasks.md` checkbox, its own entry in the review
packet. Units split at 4 tasks, when a later task needs an earlier one's *review*
verdict, or when the tasks share no files or spec — and money/auth/contracts/
migrations tasks stay 1:1 with their own reviewer on every pace.

Prompt placeholders follow: the implementer packet takes `{TASK_LIST}` and
`{TASK_IDS}` where it took a single `{TASK_ID}`.

### Reviewers are scoped to a diff range (cost/speed plan, phase B)

`{DIFF_RANGE}` is now required in both the task and final reviewer packets, and
both refuse with `NEEDS_CONTEXT` rather than rebuilding scope by reading the
repository. Directed reading — a caller whose contract changed, a spec the
excerpt cites, a spine row's file — is still expected; directory sweeps and
grepping for related code are not. A contract test pins both packets.

### Hot-path prose moved out of the phase files (cost/speed plan, phase C)

`implement.md` 342 → 269 lines and `review.md` 152 → 106, with no rule dropped.
The reasoning behind review labels, dispatch stamps and attribution — why the
session id is load-bearing, why the match is exact, what the stamp does and does
not prove, and the disclosed over-credit direction — now lives in
`references/review-labels.md`, read when a gate refuses or the scoring is being
changed. The rules stay where they are used. Phase files are read once per
session and effectively copied into the coordinator's working context; the
history does not need to ride along. The `list is **closed**:` phrase list stays
in `implement.md`, where its doc contract test reads it.

### `design.md` is optional on small changes (cost/speed plan, phase C)

Write it for ~6+ tasks, more than one capability, anything high-risk, or a
decision a reader would otherwise reverse-engineer. Otherwise skip it and say so
in one line under **Impact**. A design doc is written once and then read by every
subagent for the rest of the change, so its cost scales with dispatch count while
its value is fixed. For OpenSpec projects this is a coordinator call made after
propose — the vendor skill is not edited.

### Combined close: one pass replaces verify + review on small changes (cost/speed plan, item 8)

Phase-level metrics from the sonnet-hard-v2 cohorts showed where Forge's money
actually goes on small tasks: verify + review + done cost 2–4M input tokens per
trial against 0.4–0.9M for implement — three tail phases each re-establishing
context to check work one diff-read covers, while baseline solves the whole task
for ~0.6M.

On the way into implement, Forge now resolves **`resolvedCeremony`** from the
plan (`suggestCeremonyFromPlan`, recorded on the session with a reason):

- **`combined`** — ≤2 tasks, single capability, no wired spine rows, not
  high-risk. One **closer** subagent (new `subagents/closer-prompt.md`, ~55
  lines) is verifier and final reviewer in a single pass: reads the session
  diff, audits the red→green ledgers, runs the narrowest tier-3 command once,
  returns READY/NOT READY. Dispatched with `forge review-label final --tier
  standard`, so the census, money/auth floor and scorecard machinery are
  unchanged. One fix round, then escalate. Target ~10–15 requests for the whole
  tail against the ~50 measured.
- **`full`** — everything else: the existing verify → review pipeline, untouched.

The floor is one-way and enforced in the resolver: money/auth/contracts/
migrations/secrets and any change with wired spine rows always take the full
tail. Sessions without a readable plan (legacy `direct`) resolve from their own
declared task count and a risk read of the slug/signal, failing closed to
`full`. Pace pinning does not override ceremony in either direction. The
`forge phase done` integrity gates are identical on both paths.

## 0.3.37 — 2026-08-01

### Review guidance doc contract (F36)

A regression test extracts the closed self-declaration phrase list from
`skills/forge/phases/implement.md` and asserts each still grades as self in
`reviewCensus`.

### Shared host-tree test fixtures (F55)

Claude host-tree planters for review-evidence, collect, and review-census tests
now live in one module (`metrics/test-host-tree.mjs`) instead of three copies.

### Terminal phase predicate already centralized (F47)

Confirmed resolved: `TERMINAL_PHASES` / `isTerminalPhase` in `lib/fleet.mjs`
is the single owner; `GATE_PHASES` stays separate (includes `finish`).

## 0.3.36 — 2026-08-01

npm was still on **0.3.33**. In-tree the package version had already been
advanced through 0.3.34/0.3.35 without a publish; this release ships that work
plus the findings closed on `fix/review-coverage-cap`.

### Checkpoint refuses foreign change dirs (F72)

`forge checkpoint` refuses when untracked paths sit under another
`<plan.dir>/changes/<other>/` (not this session's change, not `archive/`),
so a sibling scaffold cannot be swept into this change's checkpoint commit.

### Cursor transcript paths (F71)

`findTranscripts` locates Cursor conversations under
`~/.cursor/projects/*/agent-transcripts/`. When the file is found but has no
Claude-format token usage, collection degrades with that path and reason
instead of claiming the transcript was pruned or written elsewhere.

### Analyze coverage buckets (F70)

`forge analyze` coverage now reports measured / predates-telemetry / collection-failed
counts instead of only a blended ratio, so a live collection failure is not
hidden among sessions that never had telemetry.

### Live score/ledger census consults host evidence (F63)

Mid-session `forge score` and the session digest now pass `reviewEvidence`
into live `reviewCensus` (same as `forge phase done` freeze), so a dispatch
stamp alone cannot outrank a host-measured stop when no frozen verdict exists.

### Score rejection count honesty (F59)

`reviewCensus` only counts structural rejection markers (`Round <n> … REJECTED`
or `**Verdict: REJECTED**`), not instructional "REJECT if …" prose.

### Cleanup OpenSpec plan root (F73)

`hasLiveChangeDir` now uses `resolveProjectPlanEngine` so OpenSpec projects
with `{ plan: { engine: "openspec" } }` and no `plan.dir` retain aged plan
sessions under `openspec/changes/`, not only under `specs/changes/`.

### Cleanup keeps plan-phase sessions with a live change dir (F48)

Bare `forge cleanup` no longer deletes an unfinished triage/plan session whose
only session-dir contents are Forge scaffold, when `openspecChange` still names
a live `<plan.dir>/changes/<name>/` directory. That change dir is held work.
`--include-unfinished --session <id>` still deletes it; archive-only paths do
not protect.

### Score group denominator and structured caps (F16, F14)

`collectPlanFacts` strips fenced code blocks and counts only numbered task-group
headings (`## 1. …` / `## 2) …`), so `## Notes` and sample headings inside fences
no longer inflate review-depth coverage notes. Scorecard `caps` are now
`{ id, applied, before, after, text }`; fleet totals count a session as capped
only when at least one entry has `applied: true` (legacy string caps still
count as applied).

### Review coverage caps the grade

Review depth was **5 points of ~100** — it could not move a grade, so the
scorecard, the one record that outlives session cleanup, said nothing
consequential about whether anyone but the author read the work. Measured
against this project's own 18 recorded sessions, three that dispatched **no
per-group reviewer at all** were graded A: `sync-tasks-md-progress` 97,
`harness-setup-probe` 94, and `session-resolution` 90 — the last on `thorough`
pace, which prescribes a reviewer after *every task*, with no review artifacts
of any kind and a final-review verdict graded `inferred` (read off prose in a
file written by the party being judged).

`forge score` now applies a fourth cap, in the same **outcomes outrank
artifacts** idiom as the other three:

| Condition | Ceiling |
| --------- | ------- |
| zero independent per-group reviews, no independent final review | 69 (C) |
| zero independent per-group reviews, independent final review exists | 89 (B) |
| at least one independent per-group review | no cap |

It fires only where reviewers were prescribed — `thorough` or `standard` pace,
at least 5 planned tasks. `brisk` and `lite` set `review.perTask` to
`high-risk-only`/`never` and are never capped for obeying their own pace, which
is the failure class 0.3.24 shipped and 0.3.26 reverted. An independent final
review **softens** the cap without removing it: reading the finished whole
answers a different question than review cadence during implementation.

Measured effect on the recorded corpus: exactly **three** sessions move, all
A→B (94→89, 97→89, 90→89); thirteen are untouched; two qualify for a cap that
changes nothing because they already score below it. Historical scores are not
rewritten — only sessions scored after this ships are affected.

### This is finding F13, and why this attempt is not 0.3.25's

**0.3.25 shipped this cap backwards and 0.3.26 reverted it.** Its guard read
`reviewUnits`, a variable assigned only inside the else-branch of the
no-reviews case: a session with **zero** reviews kept `0`, failed the `>= 3`
guard, and scored 95/A uncapped — while a session with one independent review
across six groups capped at 69/C. The cap that existed because "nobody outside
the author read this" gave full marks to exactly that session. F13 was reopened
from F10 with two binding constraints, both honored here.

*Driven by the census directly.* `reviewCoverageCap()` is a pure function whose
every input is a parameter, keyed on `census.independent` — a field
`reviewCensus` initialises to `0` at construction and returns on every path,
including the one where no review files exist. There is no branch that can skip
assigning it. It also uses **no group denominator**, so it does not inherit the
open defects in that count (F16).

*Zero-review fixture first.* It was the first test written, red, before any
production code, and it failed at exactly the 95 F13 records. A monotonicity
regression pins the inversion directly: a session with zero reviews must never
outscore an otherwise-identical one with a review.

The cap reads the **same merged census** the high-risk floor reads — live
census with the frozen verdict layered over it — so it and the `forge phase
done` gate cannot reach different answers, the defect shipped in 0.3.22.

### Three defects caught during development, all the same shape

Recorded because the shape is the subject: **a value that one path never
populates, read as though it had been measured.**

- The first corpus simulation read per-group review counts out of scorecard
  `deductions`. A check scoring full marks has no deduction entry, so four
  A-grade sessions parsed as zero-review. Caught before any code was written.
- `planFacts.readable` is true when *either* `tasks.md` or `proposal.md` has
  content, but `planFacts.tasks` counts only `tasks.md` checkboxes. A change
  with a proposal and no task checkboxes yielded `tasks = 0`, silently defeating
  the 5-task floor and disabling the cap entirely — reproduced at 95 with an
  empty `caps` array. Found by an independent reviewer, now guarded and pinned.
- The softened tier was **79**, and said so in its own message: "cap softened to
  a B". `gradeForScore` puts B at `>= 80`, so 79 graded **C** — the same band as
  the harsh tier. The softening was invisible in the grade, which is the literal
  complaint F13 was filed about. The whole suite was green across it, because
  every assertion pinned the score and none pinned the band. Now 89, with the
  grade bands themselves under test.

The last one is the general lesson: **when a threshold feeds a banded output,
pin the band** — an assertion on the raw value passes for every wrong value
inside the same band.

### The freeze qualifier now protects an `inferred` verdict too

0.3.34's own final reviewer reproduced the chain its entry had recorded as a
finding rather than fixed: a high-risk change whose review file's prose reads
independent, with one genuine unstopped final-review dispatch below the
request floor, freezes `independent`/`inferred` at `finish`. Empty the sidecar
directory and take the session to `done`: the host now reads `seen === 0`,
which `hostFinalReview` grades `self`/`host` ("nothing was dispatched"), the
frozen verdict was unprotected because `set-phase.mjs`'s keep-the-measurement
branch only ever checked `frozen.evidence === 'host'`, and the negative
overwrites it. `forge phase done` refuses the money/auth gate for a session
that really was independently reviewed — permanently, since `saveSession` runs
after the gate's `process.exit(1)`, so every retry repeats the refusal and
`--final-review-waived` was the only way through. This is findings **F49** and
**F52**, the second extending the first with exactly this reproduction and
three measured candidate fixes.

**The fix records the fact instead of inferring it, because inference cannot
tell the two cases apart.** "The record was pruned since the earlier pass" and
"nothing was ever dispatched, in either pass" produce byte-identical evidence
in a single reading — `seen === 0`, grade `self`/`host`. Nothing available to
a single pass distinguishes them; only a comparison against what an *earlier*
pass saw can. So the frozen verdict now also carries `unitOnRecord`: whether
the pass that froze it saw the deciding (`final`) unit in the host's dispatch
record at that moment. The keep rule in `set-phase.mjs` reads
`frozen.unitOnRecord ?? frozen.evidence === 'host'` instead of testing
`frozen.evidence === 'host'` alone, and `review-verdict.mjs`'s
`frozenReviewVerdict` accepts the field as optional and, when present,
strictly boolean.

**Three alternatives were measured and rejected — one of them almost shipped.**
Dropping the `evidence === 'host'` conjunct outright breaks a correct,
independently-pinned test: a stale verdict measured from prose alone must not
outrank a fresher reading of the same durable **review file**, and that
conjunct is what stops it. The durable artefact there is the file, not the
dispatch record — prose lives in the session directory and survives pruning,
which is exactly why a stale reading of it must not outrank a fresh one, and the
record's impermanence is this whole entry's premise. Testing `next.evidence === 'host'` instead of
`frozen.evidence === 'host'` breaks a sibling pin the same way. The third —
`frozen.evidence === 'host' || next.evidence === 'host'` — is the one worth
naming for a future maintainer: **it was measured to pass the entire suite,
all three e2e review steps, and close the F49/F52 reproduction outright, and
it is still wrong.** It suppresses a genuine "nothing was dispatched" host
negative on the strength of the very reading the freeze exists to distrust — a
session frozen `independent` from stale prose, then genuinely never reviewed
in the pass that matters, would still pass. A green suite is not proof of
correctness when the suite cannot yet express the case that matters; the
discriminator that catches it (a frozen `independent`/`inferred` whose unit
was *never* on record must still refresh and still refuse) is a fixture built
for this release, not one inherited from 0.3.34.

**`unitOnRecord` is optional and boolean-if-present, and no migration is
needed.** `frozenReviewVerdict` rejects any shape that is not exactly what
`set-phase.mjs` writes, so a required field would have invalidated every
verdict frozen before this change, discarding exactly the measurement the
freeze exists to preserve. Absent means "written before this field existed"
and takes the `??` fallback to the old `evidence === 'host'` test, which is
safe precisely because a host-graded independent verdict was always reachable
only from a present dispatch bucket — the new field subsumes the old test
rather than contradicting it. Absent must never be read as `false`: that would
silently assert no dispatch was ever on record for sessions where one plainly
was. Old sessions take the `??` arm and behave exactly as they did before this
release.

**What this does not close.** `seen === 0` is still unresolvable in a single
pass. If the sidecar record is already gone the *very first* time a verdict
freezes for a session, there is no earlier verdict to compare against, so that
first reading still grades `self`/`host` and `forge phase done` still refuses
— even when a reviewer genuinely ran and its record simply didn't survive that
long. That gap is **F12**'s: Forge stamping the review file itself when it
dispatches the reviewer, removing the dependency on transcript survival
altogether. It is unaffected by this release and remains open.

0.3.34's own entry below and `docs/usage.md`'s **But something downstream can**
paragraph both told operators to file a durable `--final-review-waived` waiver
against this exact refusal. Both are corrected in place with a note — neither
had its original text removed, matching how this changelog corrected 0.3.29's
entry from within 0.3.34's. The guidance survives, narrowed, for the residual
first-freeze case above.

## 0.3.34 — 2026-07-30

### A dispatch that did no work no longer certifies a review

Since 0.3.29 the money/auth `forge phase done` floor has been decided by the
host's record of a review subagent, and the census asked only *whether* a
dispatch happened — never what it did. So a throwaway subagent dispatched as
`forge-review final <session-id>`, one request long and reading nothing, graded
the final review `independent` on `host` evidence and carried a change through
the gate, against a review file stating in plain words that no subagent had read
it. An independent reviewer reproduced it; it is finding **F33**. 0.3.29's entry
offered "the record cannot be produced without really dispatching a subagent" as
the guarantee, which is true and beside the point — dispatching a subagent is
cheap. That entry is corrected in place below.

`hostFinalReview` now applies a floor of **5 requests** to the busiest single
dispatch for a review unit. Measured with the product's own
`readReviewerSidecars` over all 24 `forge-review` dispatches on this machine
(2026-07-30): minimum 15, median 55, maximum 173, none below 15. The forgery made
1. Five sits 3x under the observed minimum and 5x over the forgery. Two closes
the reproduction and little else — pad to three and walk through. Ten is only a
third under the minimum, close enough that a short review of a small change would
start to degrade. Configurable was rejected outright: a threshold an operator can
lower is one a forger can lower, and `.forge/config.json` lives inside the repo
being reviewed. F11 exists because 0.3.24 tightened a classifier in front of this
same gate on a number nobody had measured; this one has a corpus, and the design
record says to re-measure it before moving it.

**Below the floor the host says nothing — it does not say `self`.** `null` is the
answer `hostFinalReview` already gives when it cannot answer, and it routes the
verdict to the review file's prose at grade `inferred`. Grading a thin dispatch
`self` would be the fail-closed shape 0.3.24 shipped and 0.3.26 reverted — and
0.3.25's coverage cap, reverted in the same entry, cost a grade rather than a
transition, so the pair is one revert of a refusal and one of a penalty rather
than two refusals. Here it would refuse correct work for a second reason as well:
a genuine reviewer whose transcript has since been pruned reads as zero requests.

Prose is the side of this call that can only lose a grade — against the `self`
alternative, which is what that comparison is about. It is *not* a claim that
nothing downstream can refuse; the correction at the end of this entry is about
exactly that. It is also the side that closes the reproduction — the forged
session's review file admits no subagent read the change, so prose grades it
`self` and the gate refuses.

**The measurement is a per-dispatch maximum, not the sum that already existed.**
`units[*].requests`, the total across a unit's dispatches, would have answered the
wrong question: ten forged dispatches of one request each sum to ten and clear a
floor of five, and what a floor asks is whether any *single* dispatch looks like a
review. Each bucket gains `maxRequests` beside the unchanged `requests`, which
stays because it is persisted evidence other readers may want.

Stopped dispatches are excluded from that maximum, and a unit whose every
dispatch was stopped reports zero. The declined-reviewer grade is
`stopped < dispatched`, so a 60-request dispatch the operator killed sitting
beside a 1-request one that ran already reads `independent` — and an unrestricted
maximum would have let the killed dispatch vouch for the token one. A dispatch
the operator refused has had its outcome decided by the operator.

**Two fixtures had to be repaired, and that is worth saying.** `set-phase.test.mjs`
planted one transcript line per reviewer dispatch, and the e2e control step's
reviewer made two requests. Both describe a subagent that was spawned and did
nothing, and the new rule correctly declined them: tests named for a reviewer
that ran had been passing on the record of one that did not. Both now import
`FINAL_REVIEW_REQUEST_FLOOR` and plant exactly that many requests — on the
boundary rather than a comfortable multiple above it, so any tightening of the
floor turns them red instead of passing unnoticed. A new e2e step,
`review-evidence-substance`, runs the forgery end to end against the same review
file the control step passes with, and asserts the gate refuses, refuses *for the
stated reason*, and leaves the session untransitioned with no durable ledger
line.

**And this was planned long ago.** F20 asked for "request counts that distinguish
a real review from a token one", and `units[*].requests` has been collected,
windowed and persisted by `metrics/review-evidence.mjs` ever since — read by
nobody. The data needed to catch this was on disk the entire time the escape was
open.

**None of it is a security boundary**, and none of it is claimed as one: anyone
who reads this entry can pad a forged dispatch to five requests. What it removes
is the one-line forgery — the cost of faking a review rises from a throwaway
dispatch to a subagent that genuinely runs. F12, Forge stamping the review file
when *it* dispatches the reviewer, remains the real fix and is untouched here.

### `review-verdict.mjs` has a test file, and writing it found a defect

87 lines of strict validation sitting in front of that same money/auth gate, the
scorecard's cap and the durable `sessions.jsonl` digest, covered only incidentally
through `ledger.test.mjs` and `set-phase.test.mjs` while every other module in the
cluster had its own. That was finding **F34**.

Its header promised **never throws**, and shape checks alone did not buy that.
Rejecting an unrecognised shape is a `return null`, but the function reads four
properties off an object the caller supplies, and a property read can raise on its
own — a getter on `reviewVerdict`, `final`, `evidence` or `stoppedByOperator`, or
a Proxy trap. Every caller is on the `forge phase done` path, where a throw out of
here loses the transition outright: the gate never runs, the cap never applies,
no digest line is written. The body is wrapped now and a throw answers `null`, the
same answer as absent and as malformed. Nothing else about the module changed.

**One behaviour change you may notice in the digest.** `stoppedByOperator` is a
measurement only on `host` grade; everywhere else it is a placeholder `false`.
Sub-floor units now take the prose path, so a unit whose dispatches included one
the operator stopped reports `stoppedByOperator: false` where it used to report
`true` — the host's own record of a declined reviewer stops reaching the durable
digest for those sessions. That follows from the documented contract rather than
contradicting it, and it is pinned by test, but no previous entry has had to say
it out loud.

Still open and filed: prose decides in more sessions than it used to, and F11,
F18 and F19 all say the prose rules are imperfect — a deliberate trade, since
prose can misgrade while the host path was certifying forgeries. And
`set-phase.mjs` protects a frozen verdict from being overwritten only when its
evidence was `host`, so a below-floor session frozen `independent`/`inferred` at
`finish`, whose sidecar is then pruned, has that verdict replaced at `done` by
`self`/`host` and is refused.

**That path can refuse correct work, and this release makes it reachable.** A
draft of this entry claimed every session reachable through it was one the floor
meant to decline anyway. The final reviewer disproved it: a high-risk change with
a review file whose prose reads independent, and one genuine unstopped
final-review dispatch of four requests, freezes `independent`/`inferred` at
`finish`; empty the sidecar directory and `done` refuses, where 0.3.33 passed the
same session. It is permanent — the gate exits before `saveSession`, so a retry
repeats it, and `--final-review-waived` is the only way through, recording a
durable waiver against a session that *was* independently reviewed.

The floor's own answer for that session is to allow it at grade `inferred`; the
refusal comes from the freeze qualifier, which this change did not write but does
make reachable, by producing `inferred` verdicts where `host` ones used to be
produced. The fix is in `set-phase.mjs`, which this change deliberately does not
touch. **If you hit it, the session is fine and the gate is wrong** — waive it
and say so in the reason.

Recorded as a finding, with the measurements a fix will need: dropping the
`evidence === 'host'` qualifier alone breaks the pin that a stale prose verdict
must not outrank a fresh reading of the same file; testing `next.evidence` alone
breaks a different one; accepting either side passes the suite and the product
loop but suppresses a genuine "nothing was dispatched" negative. None of the
three is obviously right, which is why this release does not pick one.

**Corrected in 0.3.35.** The paragraphs above are left as they shipped. The
refusal they describe no longer reaches a below-floor session once it has been
frozen: the verdict now also records whether the deciding dispatch was on
record *at the moment it froze* (`unitOnRecord`), and a later pass that finds
the record gone, where an earlier pass found it, keeps the frozen verdict
instead of replacing it. **If you hit this refusal on a session frozen since
0.3.35, waiving is no longer the fix — it points at a different, narrower gap
(F12: a first freeze whose own reading already finds no record), not this
one.** See the 0.3.35 entry above for the fix and what it does not close.

## 0.3.33 — 2026-07-30

### `implement.md` names `--session` on the evidence line

The bare `forge evidence` command in the implement loop is how 0.3.32's blocker
was reached: it writes into `sessions/<id>/tasks/<task>/`, and `forge score`
reads that exit code into the session's scorecard and durable ledger. The
refusal added in 0.3.32 protects the record, but the instruction itself never
said which session it was writing to. It does now.

Documentation only — no behaviour change.

## 0.3.32 — 2026-07-30

### `forge evidence`'s overwrite guard was a no-op

0.3.31 tried to tell your own re-run from a clobber by writing a
`- **Session:** <id>` header and comparing it against the session it had
resolved to. Both come from the same variable — the header from `sessionId`,
the path from `sessions/<sessionId>/tasks/…` — so the comparison was a tautology
that could only fire on files the product cannot produce.

It read as a guard and permitted exactly what it was written to stop: with two
sessions open and the pointer naming B, an agent working on A ran the bare
command from `implement.md` and **B's tier-2 evidence was replaced by A's
failing run at exit 0**, the file still claiming it was B's. `score.mjs` reads
that exit code into B's scorecard and durable ledger, and the file is gitignored.
0.3.30 refused this; 0.3.31 permitted it silently.

There is nothing on disk that knows better when the session was a guess, so the
rule is back to what it was: creating a new file on a guess warns, *replacing*
one refuses, and `--session <id>` is the way through — naming the session makes
the resolution certain, after which re-runs overwrite freely. The header now
records **how** the session was decided (`named with --session` /
`resolved from .forge/active.json while several sessions were open`), which is a
fact about the resolution rather than a claim about who ran the test.

The tests that let this ship passed for the wrong reason: both hand-planted a
header naming a different session inside a session's own directory, a state no
code path reaches. They now drive the product end to end, and they kill 0.3.31's
guard.

### Smaller

- `forge cleanup --session <id>` says why a named session survived. Answering a
  request about one session with an empty list and exit 0 was the same silence
  the typo check was written to end, and it fired on the ordinary cases — a
  session younger than retention, or one whose `session.json` could not be read.
- `forge cleanup --session` with no value crashed with an uncaught
  `ERR_INVALID_ARG_TYPE`, introduced by that typo check.
- `forge status` said only `done|finish` refuse on an ambiguous session;
  `skipped`, `checkpoint`, `score --write`, `brief stamp` and `review-label` do
  too. `docs/forge.md`'s retention paragraph predated
  `--include-unfinished --session`.
- `/forge:skip` and the triage reference ran a bare `forge phase skipped`, which
  0.3.31 made refuse with several sessions open; they now say so.
- `skills/forge/SKILL.md` told you to record a declined final review with
  `forge defer`, contradicting `docs/usage.md`. An open deferral costs the full
  10 deferral points and makes `forge integrity-check` refuse; it now points at
  `forge phase done --final-review-waived "<reason>"`.

## 0.3.31 — 2026-07-29

### Follow-ups from 0.3.30's post-publish review

- **`forge phase skipped` refuses on an ambiguous session**, like `done` and
  `finish`. It looks harmless and is terminal: the session leaves the resolver's
  view so nothing warns about it again, it writes no digest line because the
  scorecard is gated on `done|finish`, and the next bare `forge cleanup` takes
  it — reviews, evidence and all. `/forge:skip`'s own template runs the bare
  command.
- **`forge evidence` no longer refuses to update its own evidence.** The guard
  keyed on whether the *project* had two sessions open rather than on whose
  evidence was already there, so every re-run of the bare command exited 1 and
  froze whatever ran first, failing or not. Evidence files now record the
  session that wrote them, so a re-run can tell its own from a neighbour's — and
  a neighbour's is still protected.
- **`forge cleanup --session <id>` now means what it means everywhere else.** It
  scopes the run to that session; it was previously ignored, so
  `forge cleanup --session A` could delete an unrelated finished session nobody
  named. A typo is an error rather than a silent no-op, and
  `--include-unfinished --session <id>` removes the session named even when the
  pointer protects it — which is the case the printed remedy exists for, and it
  silently did nothing.
- **A fleet inbox note is not work.** `forge new` plants one in every other open
  session, so counting `inbox/` as work made abandoned sessions permanently
  unclearable — the "gate refuses forever" failure through a side door.
- Four installed command templates still said *"Resume from `.forge/active.json`"*,
  which routes around the resolver entirely; they now use `forge status`.

## 0.3.30 — 2026-07-29

### Forge commands no longer disagree about which session they are acting on

`.forge/active.json` was written by `forge new` and nothing else, so "the active
session" meant *most recently created* — not the one being worked on. Fourteen
commands read it when not given `--session`.

With two sessions open and the pointer naming the wrong one, a bare
`forge phase done` — the money/auth gate — gated the neighbour: it scored that
change, wrote its permanent `sessions.jsonl` line, and left the change actually
being finished at `implement` with no verdict, no scorecard, and no trip through
the final-review floor at all. `forge status` and the session-start hook agreed
with the pointer, so nothing on screen contradicted it.

`resolveSessionId()` in `lib.mjs` is now the one decision point, and it reports
ambiguity rather than pricing it — what ambiguity *costs* is the caller's to
choose:

- **Refuse**, because being wrong writes something re-running does not undo:
  `forge phase done|finish`, `forge checkpoint`, `forge score --write`,
  `forge brief stamp`, `forge review-label`. They exit non-zero and list each
  candidate as the `--session <id>` that selects it.
- **Warn and proceed** everywhere else. Being wrong about which session is at
  `implement` costs a re-run; refusing there would block ordinary work in any
  project with two sessions open.
- Severity follows what an invocation *writes*, not what the command is called:
  `forge checkpoint --dry-run|--range`, `forge score` without `--write` and
  `forge brief check|open` do not refuse.

`forge status` and the session-start reminder report the ambiguity alongside
their answer instead of presenting a guess as a fact, and `forge phase` marks
the session it transitioned as active — below every gate, so a refused
transition does not move the pointer, and never on `done`/`skipped`, so finished
work cannot capture your status line.

### `forge cleanup` no longer deletes work in progress

`(tooOld || isDone)` removed a twenty-day session sitting at `implement`, its
verify evidence and final review inside, while keeping the *finished* session
the pointer named — and `finish.md` runs `forge cleanup` on the line after
`forge phase done`.

The line is not finished-versus-unfinished, since retention exists to clear
abandoned sessions and those are unfinished by definition. It is whether the
directory holds anything beyond Forge's own bookkeeping. Scaffolding still ages
out. `--include-unfinished` deletes work, so it requires `--session <id>`, which
also scopes the whole run to that one session.

### Smaller

- `forge evidence` records against a resolved session and refuses to *overwrite*
  existing evidence for one it only guessed at — that file is gitignored and
  feeds the durable scorecard.
- `writeJson` is atomic (temp + rename). Measured with two concurrent writer
  processes: 62 torn reads in 79 on a plain write, 0 over a rename. It starts to
  matter once `active.json` is written on every transition.
- A stray file in `.forge/sessions` no longer reads as an unreadable session and
  refuses the gate forever; a *symlinked* session is no longer invisible to it.
- `forge status` no longer crashes on a session whose declared id differs from
  its directory name.

## 0.3.29 — 2026-07-29

### Review authorship is measured, not read

Forge decides whether a change got an independent review or was reviewed by the
agent that wrote it. That verdict drives the money/auth `forge phase done` gate,
the scorecard's 69-point ceiling for an unreviewed high-risk change, the durable digest and cross-project fleet totals — and
it was decided by reading the review file's prose, which is written by the party
being judged. The rule was rewritten five times in one day and was wrong every
time; twice at the gate, once refusing correct work and once passing a session
whose own text said its reviewer had been declined.

Claude Code already records every subagent it runs. Dispatch reviewers with the
description `forge review-label <unit>` prints — `forge-review <unit>
<forge-session-id>` — and Forge reads that record instead. It cannot
be fabricated without actually dispatching a **subagent**. It does not yet prove
that subagent reviewed anything — request counts are collected for that and not
yet read.

**Corrected in 0.3.34.** The sentence above is left as it shipped, and it is
wrong in its emphasis: it presents "a subagent really had to run" as the
guarantee, when dispatching a subagent is cheap. A throwaway one carrying the
label, one request long and reading nothing, produced a record that passed the
money/auth gate against a review file stating no subagent had read the change.
0.3.34 makes the record's *substance* count. The claim as it should have read:
the record proves a dispatch, and nothing about the review.

- **Evidence outranks wording**, and where a host record exists the file is not
  consulted at all.
- **Absence never refuses.** No record — Cursor, Codex, a pruned transcript, a
  repo that has not adopted the convention — falls back to today's reading. A
  repo where dispatches exist but none are labelled is detected as *not using the
  convention* rather than judged as unreviewed; without that, measured against
  every real dispatch record on the author's machine at the time — several hundred,
  of which a handful carried a label and **none** labelled a final review — the
  gate would have refused essentially every existing session.
- **The verdict is frozen** at `finish`/`done`, before the gate reads it, because
  transcripts are pruned within days. A measured `independent` is never later
  downgraded to a guess; a stale `self` never survives to refuse a session that
  was since reviewed.
- **Every verdict carries a grade** — `host`, `inferred` or `none` — in
  `session.json` and in `sessions.jsonl`, and `forge fleet report` refuses to sum
  across grades silently. A digest line predating the field reads as unknown,
  never as a grade.
- **A declined reviewer is reported, not assumed.** The host records when an
  operator stops a dispatch; Forge records it on the session and in the digest
  rather than applying a waiver on your behalf. It is not yet shown in any
  human-readable output — the gate and the scorecard still say only "missing or
  self-authored".

- **A dispatch record names the session that made it.** The description is now
  `forge-review <unit> <forge-session-id>`, and `forge review-label final`
  prints it. Without the id the join was "a review dispatch somewhere in this
  conversation while this session was open" — and one Claude Code conversation
  routinely hosts several Forge sessions, so a neighbour's reviewer was
  indistinguishable from your own. Three independent review rounds each found a
  fresh way for that to pass a *self-written* review through the money/auth
  floor at score 93: a window a later session's dispatch still landed inside, a
  `forge cleanup` that erased the neighbour's record, and a ledger line predating
  the field that said which conversation a session ran in. Naming the session
  ends the class rather than patching it — there is no window, no sibling search
  and no shared-conversation index left to get wrong.

  A dispatch described in the older two-word form is counted for nobody: Forge
  reports that it cannot tell and reads the review file's wording, which is the
  fallback rather than a refusal. That cost is per *conversation* and permanent
  — one old-form dispatch anywhere in a Claude Code session, including a
  neighbouring Forge session's, keeps the whole conversation on the prose rule.
  Adoption is near zero today, so nearly every existing session lands on the
  prose fallback rather than on measured evidence.

  `forge review-label [<unit>]` prints the label, and `forge phase` now marks
  the session it transitions as active — `active.json` was written only by
  `forge new`, so "active" meant *most recently created*, and a coordinator
  resuming an earlier session was handed the neighbour's id.

Also from that review: a measured `independent` is no longer overwritten when the
dispatch record is *pruned* between `finish` and `done` — which previously
refused the session permanently, since the refused pass never wrote its own
downgrade. `SKIPPED (pace=…)`, the string Forge itself prescribes for a
pace-skipped final review, no longer counts as an outside reader. And a dispatch
that ran but cannot be placed in time is counted rather than dropped, so a pruned
sidecar transcript falls back to prose instead of reading as "nothing ran".

Still open and filed: host evidence is read from a partial binding without
saying so (a session bound to two host sessions, one of whose transcripts has
expired, answers confidently from the other).

## 0.3.28 — 2026-07-28

### Review totals from different census rules are flagged, not silently summed

Four classifiers wrote review verdicts into `.forge/sessions.jsonl` in a single
day — the pre-0.3.24 phrase list, 0.3.24's fail-closed attribution, 0.3.26's
attribution region, and 0.3.27's coordinator declaration — and nothing recorded
which. `fleet-report` added `independent` and `selfChecks` across projects
regardless, printing a cross-project total that mixed incompatible scales with
the confidence of a single-rule one.

`reviewCensus` now stamps an integer `CENSUS_RULE` on its verdict, the digest
carries it as `reviews.rule`, and a line written before the field existed reads
as rule 0 rather than as "no rule". When a fleet spans more than one, the report
says so instead of hiding it:

```
  reviews: 12 dispatched · 5 self-check · 2 rejection round(s) · …
    ⚠ mixed census rules (0, 3) — these review totals sum verdicts produced by
      different classifiers and are not comparable
```

Bump `CENSUS_RULE` whenever classification changes. Every existing session on
this machine is rule 0, so the warning appears the first time a session finishes
under 0.3.28.

### `forgekit install` no longer disables ADRs when you never mentioned them

`inferAdrFromSkills` is tri-state on purpose — `true` (`--adr`, or an ADR skill
in the selection), `false` (`--no-adr`), `null` (the user said nothing) — and
`resolveAdrInstallOptions` collapsed it with `=== true` one line later. `null`
became `false`, and that was persisted to `~/.forgekit/config.json` and
announced as *"ADR preference saved: disabled"*.

So `forgekit install --skills forge` — a command whose entire job is refreshing
one skill — silently changed the ADR default for every future `forge init`.
Per-project config was untouched, which is why it was easy to miss.

Silence is no longer a preference: with no signal the stored value is left
alone and nothing is printed. `--adr` and `--no-adr` behave exactly as before.
The `agents` key in the same `saveUserConfig` call already worked this way
("narrow flag runs don't clobber it"); `adr` now matches it.

Worth naming the shape, because it is the second one today: **absence of a
signal treated as a negative signal**. The same mistake in `reviewCensus` took
four review rounds and three releases to settle.

## 0.3.27 — 2026-07-28

### Naming the coordinator as the reviewer is a self-declaration

0.3.26 shipped with a gate escape, found by an independent design review an hour
after publish. `SELF_REVIEW_RE` knew `reviewed by the coordinator` but not
`Reviewer: coordinator` — the skill's own prescribed phrasing minus its
`self-check` suffix. A real final review reading

> **Reviewer:** coordinator. A final-reviewer subagent was dispatched and
> **declined by the operator**

classified as **independent**, on a high-risk session with no waiver: exactly the
case the money/auth `forge phase done` floor exists for.

Two guards keep the new alternative from erring the other way, both with tests.
Only punctuation and emphasis may sit between the attribution and the name, so
`Reviewer: claude-opus-5, dispatched by the coordinator` stays independent; and a
trailing `(?!-)` keeps `Reviewer: coordinator-dispatched opus subagent` — the word
used as an adjective — from being demoted. Demotion refuses work, so a false one
costs more than a false promotion.

One artifact in the local corpus of 34 changes classification, which is the one
that prompted the fix.

## 0.3.26 — 2026-07-28

### Reverts 0.3.24 and 0.3.25's scoring changes

**If you are on 0.3.24 or 0.3.25, upgrade.** An independent review of those two
releases found two Critical defects, both reproduced:

- **`forge phase done` refused correct sessions.** 0.3.24 made review
  independence something a file had to *claim* via a `Reviewer:` attribution.
  Measured against real artifacts it was wrong in both directions: a dispatched
  review heading with `Reviewed:` — this project's own, the one that caught a
  28.6% token undercount and rejected the work — demoted to a self-check, while
  `coordinator self-audit` promoted to independent. `set-phase.mjs` gates the
  done phase on the same function, so a high-risk session whose independent
  final review already existed was blocked, with the remedy already followed.
- **0.3.25's coverage cap was backwards.** `reviewUnits` was only assigned when
  review artifacts existed, so a session with **zero** reviews kept `0`, failed
  the group-count guard and scored **95/A uncapped** — while a session with one
  independent review of six groups capped at 69/C. The cap that exists because
  "nobody outside the author read this" gave full marks to exactly that session.

Both are reverted. The `contract` narrowing from 0.3.24 goes with them: the same
review measured eight of twelve genuinely risky sentences losing their match,
and the surviving qualifiers required a single space or hyphen, so plan prose
hard-wrapped at 80 columns disarmed them at a line break. This regex fails
closed on purpose — a false positive costs one dispatched reviewer, a false
negative ships an unreviewed money/auth change.

The concerns F3, F9 and F10 addressed are live again, recorded as new entries in
`.forge/findings.jsonl` (the ledger has no reopen verb, so the originals stay
`resolved` with notes describing the now-reverted fixes). Both attempts at F9
have shown the same thing: prose cannot measure authorship. The fix is
structural — Forge stamping the review file when *it* dispatches the reviewer —
not a wider regex.

Because the census infers independence from the *absence* of a self-declaration,
the phrases Forge itself prescribes have to be ones it recognises: `self-check`,
`self-audit` and `self-authored` now join the four it already knew, matched
against the review's **attribution** — its opening lines and any `Reviewer:`
line — never its whole body. The skill, both reviewer prompts and `docs/usage.md`
were corrected to stop asserting scorer behaviour that no longer exists.

Three independent review rounds were needed to get that right, and each found a
defect worse than the one being fixed. The first revert changed `packages/cli/src`
only, leaving Forge instructing coordinators to write `Reviewer: coordinator —
self-check` — which the reverted census read as **independent**, defeating the
money/auth `forge phase done` gate with Forge's own documented phrasing. The fix
for *that* then matched the new phrases against the entire review body, so a
dispatched reviewer who merely described which groups were self-checked — the
ordinary thing to do — was demoted and the gate refused correct work, under a
code comment asserting that could not happen. Scoping *that* to the opening two
lines then let a real hard-wrapped declaration escape: a live final review whose
own text says dispatch was declined twice wraps `self-review` onto its third
line, and a high-risk session sailed through the gate. The window is paragraphs
now, because prose wraps and regexes do not — which is the same reason the
`contract` narrowing was reverted, one section above.

`forge phase done` also stopped making a promise it did not keep: the reason
recorded by `--final-review-waived` is now carried into the `sessions.jsonl`
digest, so it survives `forge cleanup` alongside the cap it explains.

**Kept**, verified independently correct: the `isReviewContainer` denominator
fix (a `group-NN-*` folder is a review, not a unit of work needing one),
`healCachedScore`, `writeMetrics`, and 0.3.23's gate/scorer risk union.

## 0.3.25 — 2026-07-28

### Thin review coverage caps the grade

Review depth was 5 points of ~100 — it could not move a grade. A session whose
own scorecard said *"1 dispatched review across 12 task groups"* and *"final
review is self-authored"* still came out an A. Every other
outcomes-outrank-artifacts lever in the scorer is a **cap** (incomplete → 59,
red product loop → 69, high-risk without an independent final review → 69);
this one now is too.

It is deliberately narrow. The cap fires only where reviews were expected
(`thorough` / `standard` pace, or 15+ tasks — `brisk` and `lite` are *told* to
skip reviewers and are not punished for obeying), only on changes the plan split
into **3 or more task groups**, and only when fewer than half the groups had an
independent reviewer **and** no independent final review exists. An outsider who
read the whole change lifts it, exactly as it lifts the high-risk floor.

### The scorer stopped charging sessions for doing group reviews

`tasks/` holds implementer batches *and* the `group-NN-*` folders their group
reviews live in, and the scorer counted both as units of work. A session was
penalised twice for reviewing properly: the tier-2 evidence ratio fell (a review
folder carries no `test-evidence.md`) and review coverage was measured against
an inflated denominator. This project's own session read *"tier-2 evidence in
9/12 task dirs"* while all nine of its batches had evidence.

Review folders are now identified by content rather than by name, and coverage
is measured against **tasks.md groups** — the unit one `per-group` review
actually covers. The same session now reads 9/9 and *"1 dispatched review across
6 task groups"*.

## 0.3.24 — 2026-07-28

### Review independence must be claimed, not inferred

**Behaviour change — read this if you rely on session scores.** `reviewCensus`
promoted a review to "independent" whenever it *lacked* a self-review phrase,
and the phrases it knew were only the ones the templates emit. A group review
headed `Reviewer: coordinator (self-check, not independent)` was therefore
counted as an outside reader — inferring the strongest signal in the scorecard
from the absence of a word, which is the exact mistake this module was written to
remove one level up.

It now fails closed. An explicit self-declaration is believed however it is
phrased, and independence requires a `Reviewer:` attribution that does not name
the coordinator. **A review that claims no reviewer counts as a self-check.**

The cost is one line, and Forge now writes it for you: `forge phase implement`
instructs the coordinator to head every review file with `Reviewer:`, and both
reviewer prompts open their report with `Reviewer: <model> (<role>)`.

Existing reviews that named nobody will re-score as self-checks. That is the
honest count — this project's own session dropped from 3 independent reviews to
1 — but it will move numbers in `.forge/scorecards.jsonl` for sessions you
re-score.

### Bare "contract" no longer reads as high-risk

Third of the same family, after `auth` and `checkout`. "contract" is how
programmers describe *any* function's promise, so a change whose plan said "the
same contract as `readLedger`" or "not a public contract" was escalated to
thorough pace and held at the independent-review floor while touching no money,
auth, secret or migration surface — six such matches in one change, every one a
sentence about a JavaScript calling convention.

The risk sense is always qualified, exactly as `STANDARD_RE` already spells
"wire contract": `(api|wire|schema|smart|service|breaking) contract(s)` and
`contract test(s)/testing/breach` now match, the bare noun does not. A change
that really does move money or break a consumer still matches on its other
words.

### A degraded metrics collection no longer overwrites real numbers

Host transcripts get pruned. Re-running `forge metrics collect` on a finished
session traded its per-model and per-phase detail for `available: false` — and
`metrics.json` is the only place that detail lives, since the digest keeps
totals alone. A document that says `available: true` is now preserved unless you
pass `--force`; better news, equally bad news, a corrupt file and a first
collection all write as before. `forge phase finish|done` gets the same
protection, because a `finish` then `done` pair collects twice.

### Re-scoring heals the cached score

The score lives in three places: `scorecard.json`, the `sessions.jsonl` digest,
and `session.score` / `session.scoreGrade`. `forge score --write` rewrote the
first two and left the third asserting the old number — observed as session.json
claiming 97/A against a scorecard reading 69/C. Same shape as ADR-0002: a
derived cache heals when it diverges. `updatedAt` is deliberately left alone —
re-scoring is not activity, and bumping it would reset idle/STALE detection.

### Briefing rules that cost real defects

Two lessons from the session-telemetry change, now in the skill rather than in a
report nobody re-reads:

- **Mark what you measured.** A brief is read by a subagent with no chat
  history, so every sentence lands as fact. Load-bearing claims are tagged
  `measured: <how>` or `assumed — verify`. A data-format rule stated flatly
  alongside measured facts turned out to be an assumption, and it survived TDD,
  self-review and a corpus check because every fixture had been built from the
  brief's own premise.
- **Never quote an expected value.** Briefs state the rule and the fixture; the
  implementer derives the numbers in code and must prove each guard fires by
  reintroducing the bug it guards. Three quoted figures reached one change's
  briefs; each would have produced an assertion that passed against buggy code
  while reading as coverage.

`tdd-core.md` also gains **selection rules need a discriminating fixture**: when
the behaviour is *which candidate wins*, the losers must differ from the winner,
or the test proves only that the rule ran.

## 0.3.23 — 2026-07-28

### The scorer now reads risk from the same text the done gate does

`forge phase done`'s independent-final-review floor and the scorecard's matching
cap were built on two different definitions of "high-risk". The gate asks
`collectPlanFacts`, which scans `proposal.md` / `design.md` / `tasks.md` and the
spine; `score.mjs` built its own string from slug + paceSignal + change name +
spine only. A change that states its risk in plan prose — the ordinary case,
since a slug written at session start rarely says "auth" — was blocked by the
gate and then scored **uncapped**.

The 0.3.22 release was itself the proof: it blocked on the floor, recorded a
waiver, and scored 97/A with `caps: []`, while `score.mjs`'s own comment says a
cap is the thing that survives cleanup. Re-scored with this fix it is 69/C, with
the cap naming the self-authored final review. Found by the telemetry that
release shipped.

The scorer now takes the union of both readings, so it can only ever become more
sensitive: a session with no change dir (direct/throwaway) still gets the old
slug-based read, and an unreadable plan cannot lower the floor.

## 0.3.22 — 2026-07-28

### Session telemetry — what a session actually cost, and whether the model policy held

A Forge session recorded how *disciplined* it was — score, reviews, deferrals —
and nothing about how it *ran*. Tokens, models, failing tools, how much work went
to subagents, and whether `forge resolve-model` was honoured were all invisible,
so every claim about the workflow was an impression.

Forge now reads that from the host's own JSONL transcripts. **It is a reader, not
a recorder**: Claude Code already writes every request to disk, and the only
missing link was knowing which transcripts belong to which session. That link is
`CLAUDE_CODE_SESSION_ID`, which is already exported into the shell `forge` runs
in — so binding needs no hook, and a session resumed tomorrow under a new host
session simply appends the new id.

- **`forge metrics collect`** harvests the bound transcripts into
  `.forge/sessions/<id>/metrics.json`: requests, the four token classes, per-model
  and per-phase splits, tool calls and failures, one record per subagent, and a
  coordinator-vs-delegated breakdown. `forge phase finish|done` runs it
  automatically, just before the scorecard.
- **`forge analyze [--json]`** reads `sessions.jsonl`, `scorecards.jsonl` and any
  surviving `metrics.json` back as numbers. Read-only, deterministic, and it
  **states coverage first** — "6 of 9 analysed sessions carry metrics" — because a
  partial history read as a complete one is worse than no history.
  `/forge:analyze` now takes its quantitative source from here instead of
  recomputing by hand.
- **Dispatch ledger.** With the `forge enforce-model` PreToolUse hook wired, every
  subagent dispatch is logged and rolled into a skip rate: how often a dispatch had
  to be rewritten or refused because the resolver was skipped. Zero skips *with no
  dispatches recorded at all* means the hook is not installed, and the output says
  which of the two it is.
- **`sessions.jsonl` carries compact totals**, so the numbers outlive
  `forge cleanup` deleting the session directory. `subagentsDispatched` — `null` in
  every digest this project has ever written, because it was a figure a
  coordinator maintained by hand — is now measured from the host's own sidecars.

Two rules the implementation is built around, both learned the hard way:

- **Usage is counted once per request.** The host writes one transcript line per
  content block and repeats the whole `usage` object on each, and the *first* line
  of a request carries a preliminary output count that is later settled. Summing
  lines inflates tokens ~3×; keeping the first line understated output by 28.6%
  across a real corpus. Both numbers look entirely plausible downstream.
- **Telemetry is advisory, always.** Collection, dispatch logging and digest
  enrichment cannot throw, cannot change a hook decision, and cannot block a phase
  transition. Every failure — no host, pruned transcript, corrupt file — is
  recorded as `available: false` with a reason and exits 0.

**Privacy:** persisted metrics contain counts, model slugs, tool names, agent
types, phase names and timestamps. Never prompt text, model responses, command
strings, file contents, or a subagent's `description`.

`session.json` gains `host` (`{agent, sessionIds[], boundAt}`) and `phaseHistory`
(`[{phase, at}]`, the join key that attributes requests to the phase they were
spent in). Both are additive; sessions without them still load.

## 0.3.21 — 2026-07-27

### Fleet/status progress follows `tasks.md` checkboxes

Agents tick OpenSpec/specs task lists; fleet and health used to watch a separate
`session.tasksComplete` cache that only moved on `forge phase --tasks-complete`.
A busy implement session could show `0/N` and `STALE` for hours. Progress is now
derived from the linked `tasks.md` on status/fleet/reminder (session cache is
healed when it diverges), and idle detection treats `tasks.md` mtime as activity.

## 0.3.20 — 2026-07-26

### `--version`, because a stale install looks exactly like a missing feature

None of the three bins answered `--version`; all of them treated it as an
unknown command and printed help. That is a bad failure mode for a tool that
ships new subcommands: `forge enforce-model` landing in 0.3.19 is
indistinguishable from a global install still sitting on 0.3.18, and the first
question — *which copy is answering?* — had no way to be asked.

`forge`, `forgekit` and `review` now accept `--version` and `-v`, printing
`<bin> <version>` (the bin name included because three commands share one
package). The number is read from that package's own manifest rather than
hardcoded, since a hardcoded string is precisely what drifts from the installed
copy; an unreadable manifest reports `unknown` instead of throwing.

## 0.3.19 — 2026-07-26

### The model overlay can now hold, instead of only advising

`forge resolve-model` is a contract: run it before every subagent dispatch, pass
back the model it returns. Measured in a real project, the contract is skipped —
`.forge/models.local.json` said `opus` for every tier from 08:47Z onward, and
dispatches at 11:24Z, 12:10Z, 13:58Z and 15:44Z still went out on `sonnet`. The
resolver was right every time; nothing ever asked it. An overlay that silently
does nothing is worse than no overlay, because the operator believes it took.

`forge enforce-model` reads a `PreToolUse` payload on stdin and answers with a
hook decision. `forge init --claude` ships `.claude/hooks/forge-model-hook.mjs`
and registers it on `Agent|Task` in the hooks snippet.

The dispatch payload carries a model but no tier, so the intended tier cannot be
recovered. That admission shapes the whole design — two rules, and nothing else:

- **A lane whose three tiers are one model** has nothing left to decide, so the
  dispatch is rewritten to it (`inherit` rewrites to *no* `model` parameter).
  Hand-write `fast`/`standard`/`capable` to the same value when every subagent
  should get one model.
- **A lane that keeps tiers apart** can only be checked, not corrected: a model
  outside the resolved three is denied, and the denial names the table and sends
  the coordinator back to `forge resolve-model`.

**Without `.forge/models.local.json` the command allows everything, before
either rule is consulted** — a project that has not opted in sees no behavior
change, including for models outside the default table. Every failure path
allows too: unparseable payload, corrupt overlay, unknown agent, `forge` missing
from `PATH`. A policy hook that can block work is a worse bug than the one it
fixes.

Claude Code only — Cursor and Codex have no dispatch hook to hang this on, so
there the resolver stays an instruction.

## 0.3.18 — 2026-07-26

### A recorded harness now travels to the operator's machine

`forge e2e harness` recorded how to *boot the app* and nothing about the rig
that exercises it. Reported from the field: an agent recorded a Playwright
harness, `/forge:harness` proved it green in the agent's environment, and the
operator's fresh checkout failed on the first `npm run test:e2e` with "browser
executable doesn't exist". The agent's sandbox already had the browsers, so the
harness was proven exactly where nobody needed it proven.

- `--setup "<cmd>"` records what **this machine** needs that the repository
  cannot carry — browsers, drivers, container images, toolchains.
- `--probe "<cmd>"` records the command that proves the harness. `/forge:harness`
  step 1 already told agents to re-run "one real probe" against an existing
  harness; there was nowhere to record which one, so every session re-derived it.
- Both print wherever the harness is shown (`forge e2e harness`, `forge e2e
  init`) and serialize in `forge e2e status`, ordered Setup → Start → Probe →
  Location: the order you run them.
- **When a loop goes red and a `setup` is recorded, `forge e2e run` names it as
  the first thing to suspect.** Forge detects no tools and installs nothing —
  the probe's own error is the check, and attributing it is what forge can do
  without knowing Playwright from chromedriver. Advisory only: it never changes
  the exit code, and prints on neither a green run nor an unrecorded setup.
- Skill and command templates carry the rule: *a harness proven only in the
  agent's environment is not proven.* Anything installed to make the probe pass
  gets recorded as `setup`, and forge never auto-installs on the operator's
  behalf.

Both fields are optional; harnesses recorded before this print unchanged.

### `checkout` no longer reads as a payment term

The high-risk detector listed a bare `checkout` alongside stripe/billing/wallet.
But "checkout" is core git vocabulary — "a fresh checkout", "once per checkout"
— so any change that discussed working copies read as high-risk and hit the
review floor. Found the honest way: the harness change above blocked its own
`forge phase done`, on a plan that said "checkout" four times in the git sense
and touched no money surface.

Now qualified — `checkout session|flow|page|form|button`, and
`guest|express|one-page checkout`. Recall barely moves, because the words a
real payment change carries (stripe, payment, billing) are already alternatives
in that pattern, so "stripe checkout" still matches via `stripe`. Same shape as
the 0.3.17 note about `auth\w*` swallowing "author": qualify, don't delete.

Fail-closed on a *negated* mention ("No migration.") is unchanged — that is
documented as deliberate.

## 0.3.17 — 2026-07-25

### Pace is decided where the facts are

`pace: auto` classified a free-text slug written at session creation. Across
five real sessions it returned `standard` every time — three via "unrecognized
scope — failing closed" — while `brisk` and `lite` were documented and never
selected: a constant dressed as a decision.

- On the way into **implement**, `auto` now re-resolves from the plan: task
  count, group count, capabilities, spine rows, and whether anything in the
  proposal / design / tasks / spine touches money/auth/contracts/migrations.
  The session records `paceResolvedFrom: "plan"` and a reason naming the facts.
  A pinned pace is never overridden; an unreadable plan still fails closed.
- **Fixed a real gap in risk detection:** `\bauth\b` matched "auth token" but
  missed "authorization gate", "authenticated user" and "authorized signer" —
  the words specs and spine rows actually use for the highest-risk category.
  (`auth\w*` is not the fix: it swallows "author"/"authoring".) This also
  sharpens the 0.3.16 high-risk score cap.

### The high-risk review floor is a gate, not a paragraph

`forge phase done` now refuses when a change touches
money/auth/contracts/migrations and its final review is missing or
self-authored. The rule already existed in the skill and in three analysis
reports, and was skipped anyway — the session that most needed it recorded
"dispatch was declined twice" in review prose no gate could see. Escape:
`--final-review-waived "<reason>"`, kept on the session and carried into
`.forge/sessions.jsonl`, because a waiver that survives cleanup is worth more
than a caveat that does not.

### `forge fleet report`

Cross-project trend from the durable ledgers: mean score, grade distribution,
caps, review coverage and rejection rounds, where points are lost, and carried
debt. On the two real projects here it reproduces in one command the headline
finding three hand-written analyses took to reach — `product_loop −57 pts
across 6 sessions`.

### `forge e2e run --repeat N [--record-baseline]`

Runs the product loop N times and reports which steps are **flaky** (failed
some runs) versus **broken** (failed every run), optionally recording
`e2e.baseline` in `.forge/config.json`. A project whose clean-tree baseline is
"1–4 varying failures" makes every verify phase a coin flip and a real
regression indistinguishable from noise. A flaky loop is never written as a
green run: the worst run is what lands in `e2e-results.json`.

## 0.3.16 — 2026-07-25

### Scoring measures outcomes, not paperwork

Seven scored sessions across two projects landed between 80 and 100 while the
things that actually varied — 3 vs 31 subagents, one group review vs nine, a
rejection with a blocker vs a self-approval — were invisible to the score.

- **Review depth is scored by what was dispatched.** It used to start at 5/5 and
  only ever subtract, so a session with *no reviewer of any kind* scored full
  marks. Now: coverage of independent reviews across task groups (one review
  across eight groups reads as "thin coverage"), whether the final review is
  independent or self-authored, and **+1 when a round rejected work before
  approving** — a review that sent work back demonstrably was not a rubber stamp.
- **Two new caps at 69 (grade C).** A `red` session health (failing e2e run or
  BLOCKED verify evidence) caps the score: outcomes outrank artifacts. So does a
  high-risk change without an **independent final review** — risk is now read
  from the spine as well as the pace signal, and fails closed (a negated mention
  still counts; the cost of being wrong is one dispatched reviewer). Per-group
  reviews do not lift it: each saw one slice.
- Re-scored against real history: a 38-task session with one group review and a
  self-authored final review goes **100 → 69 (A → C)**, with the reason named in
  `caps`; a session with nine dispatched reviews, an independent final review and
  four rejection rounds stays **97 (A)**.

### Durable ledgers — `.forge/sessions.jsonl`, `.forge/deferrals.jsonl`

Cleanup deletes the session dir at done, taking reviews, deferrals, fix-round
briefs and evidence with it (5 of 6 scored sessions in one project were already
gone). `phase done` now also writes, next to the existing `scorecards.jsonl`:

- **`sessions.jsonl`** — one digest per session: tasks, subagents dispatched,
  reviews by kind, rejection rounds, checkpoints, health verdict, duration.
- **`deferrals.jsonl`** — unresolved deferrals with the session that owed them,
  so carried debt outlives the session that raised it.

### `forge finding` — an observation gets a home the day it is written

Analysis reports kept re-listing the same unactioned items because nothing
converted a report line into tracked work.

```bash
forge finding add "<text>" [--change <slug>] [--severity blocker|major|minor|note]
forge finding list [--json] [--all]
forge finding resolve <id> [--note "<text>"]
```

Durable `.forge/findings.jsonl`; open findings appear in `forge status`, so they
cannot quietly disappear between sessions. Filing works without an active
session (reports are usually written between them). Naming a `--change` records
the intended home and prints the command to open it, rather than scaffolding
one behind your back.

## 0.3.15 — 2026-07-25

### `forge checkpoint` — opt-in commits at group boundaries

A long session used to accumulate the whole change as one uncommitted working
tree (a 32-task session on helm: 6k lines across 37 files plus 18 untracked
ones), so a stray `git checkout` could erase a day of agent work, and every
reviewer after task 1 read a diff containing all previous tasks.

- Off by default. Opt in per project: `.forge/config.json` →
  `{ "git": { "checkpoint": "per-group" } }` (or `per-task`, `off`).
- **Never pushes.** Refuses on `main`/`master` unless `--allow-default-branch`
  (or `git.allowDefaultBranch: true`), refuses mid-merge/rebase/cherry-pick/
  revert/bisect, and excludes `.forge/` so session scratch never lands in
  project history.
- A clean tree is success, not an error, and never produces an empty commit.
- Records `{ sha, group, tasks, at }` on the session. `forge checkpoint --range
  [--last]` prints what a reviewer should read as `reviewTarget`: a group
  review runs *before* its checkpoint, so while the group is uncommitted that
  is `git diff <last checkpoint>` plus the untracked files named explicitly
  (a diff never shows them, and new files are most of an implementer's output);
  once checkpointed it collapses to a plain commit range. The `range` field is
  the commit range only and is empty mid-group by design. `forge new` now
  records `baseCommit` + `branch`, so a base exists even with checkpoints off.
- Implement phase and the task-reviewer prompt updated to use it.

### Session health

`forge status` printed every field a session had and never said whether the
session was in trouble — helm's phase-1 sat at `implement 27/32` with a red
e2e run for 14 hours and looked identical to one mid-stride.

- `forge status` gains `health`: `red` (e2e run failing — names the step — or
  `verify-evidence.md` records BLOCKED), `stale` (idle past
  `health.idleHours`, default 4, or e2e results no longer matching `e2e.json`),
  `healthy`, `done`. Red outranks stale; all reasons are reported.
- `forge fleet list` gains a HEALTH column plus a reason line per unhealthy
  session, so a red or abandoned session is visible without opening the project.
- The reminder hook leads with the health line on resume when it is not healthy.

## 0.3.14 — 2026-07-25

### Fixes

- **Specs-engine sessions no longer resolve into `openspec/`.** `resolveChangeDir`
  took `.dir` from the plan-engine resolver unconditionally, and that resolver's
  last resort is `{engine: 'openspec', dir: 'openspec'}` — so a session with
  `planType: 'specs'` in a project whose `.forge/config.json` has no `plan` block
  (ADR-only config, pre-engine config, hand-written) looked for its change under
  `openspec/changes/<name>`. Symptom: `forge phase implement` hard-refused with
  "operator brief missing" while the stamped brief sat in `specs/changes/<name>/`;
  spine / e2e / integrity read the wrong tree the same way. Only a *specs*
  resolution can name the specs dir now; anything else falls back to `specs/`.
- **`forge` works from a subdirectory.** The project root was whatever `process.cwd()`
  happened to be, so `cd crates && forge status` reported "no session" in a repo
  that had one, and `forge new` there would have written a second `.forge` tree
  inside the workspace. The bin now re-roots each subcommand at the nearest
  ancestor holding `.forge/` (else `.git/`, which also stops the walk so a nested
  checkout can't adopt its parent's sessions), exports `FORGE_INVOKED_FROM`, and
  absolutizes a relative `--cwd` against the invocation dir first.
- **Undatable sessions age out.** `sessionAgeDays` read only `createdAt`;
  a record without one produced `NaN`, and `NaN > RETENTION_DAYS` is false, so
  abandoned sessions survived every `forge cleanup` forever. It now falls back to
  `startedAt` / `updatedAt` and treats a record with no readable date as
  infinitely old.
- **`forge fleet list` reconciles against disk.** Registry entries are a cache;
  a session whose phase advanced without a mirroring write (older CLI, a crash)
  showed its first-registered phase forever — a finished 20/20 session still
  listed as an in-flight `brainstorm`. Entries are now refreshed from each
  `session.json` on read and the corrected entry is persisted.
- Removed a dead assignment in `specs-sync.mjs` that made `npm run lint` fail.

### Release safety

- `npm run lint` runs in CI, and `prepublishOnly` runs lint + tests — 0.3.13
  shipped with a red suite (3 failures) and red CI, which this makes impossible.

## 0.3.13 — 2026-07-24

- **Specs engine OpenSpec format parity.** Built-in engine now scaffolds the full
  OpenSpec layout: main `<plan.dir>/specs/<cap>/spec.md`, per-change delta
  `changes/<name>/specs/<cap>/spec.md` (ADDED/MODIFIED/REMOVED — not a
  `deltas/` folder), `design.md`, and a Capabilities section on proposals.
  `forge change new … --capability <id>` stubs deltas; `forge change archive`
  merges them into the main catalog before moving the change (`--no-sync` to
  skip).
- **`forge init --plan-dir <path>`.** Sets `plan.dir` for the specs engine
  (default `specs`). Use `--no-openspec --plan-dir openspec` to switch from
  OpenSpec without moving files.
- **`forge init` no longer falls back to specs on OpenSpec setup failure.**
  Choosing OpenSpec (flag, user default, or interactive pick) always records
  `plan.engine: openspec`; setup is best-effort.

## 0.2.0 — 2026-07-20

- **Executable E2E acceptance (`forge e2e`).** The product loop is now *run*, not described. `forge e2e init` scaffolds `e2e.json` next to `spine.json` — the closed loop as `{ name, cmd, expect?, timeoutMs? }` steps; `forge e2e run` executes them sequentially (exit 0 + regex match required) and writes `e2e-results.json` with per-step outcomes and a hash of the steps, so editing steps after a green run invalidates the results; `forge e2e check` verifies green + current.
- **Done gate now demands the executed loop.** When the spine has real rows, `forge integrity-check` / `forge phase done|finish` require a green, current e2e run — a `## Product loop` prose section in `verify-evidence.md` no longer satisfies the gate (the `BLOCKED` escape and `--allow-incomplete` are unchanged). `e2e.json` may set `notApplicable: "<reason>"` only for loops no command can drive; reviewers police the reason. Sessions upgraded mid-flight: run `forge e2e init`, author steps, `forge e2e run`.
- Plan phases now scaffold `e2e.json` when the spine has rows (steps are a plan deliverable); reviewer prompts REJECT step lists that would pass against a stubbed handler.

## 0.1.7 — 2026-07-20

- **Thin rules are engine-neutral.** The `forge.md` project rules no longer hardcode OpenSpec — they point at `.forge/config.json` (`plan.engine`) and give the command for both engines (`/opsx:propose` for OpenSpec, `forge change new <slug>` for the built-in specs engine).
- **`forge init` refreshes its own managed files.** Command, rule, and hook files (all forge-owned pointers) now update in place on re-run instead of being skipped, so template fixes — like the corrected `~/.<agent>/skills/forge/docs/forge.md` reference — reach existing projects without `--force`. Reported as `updated`/`unchanged`/`written`.

## 0.1.6 — 2026-07-20

- **`forge init` pre-selects your environments in OpenSpec setup too.** When init runs `openspec init`, it now passes your chosen environments via `openspec init --tools <ids>` (mapping `copilot` → OpenSpec's `github-copilot`), so OpenSpec configures exactly those tools non-interactively instead of showing its own 24-tool picker with nothing selected.

## 0.1.5 — 2026-07-20

- **`forge init` offers the same environments as `forgekit install`** (all seven) and pre-checks the ones you picked during install — saved to `~/.forgekit/config.json` — so you don't select them twice. Environments without project-wiring templates (Copilot, Gemini, Windsurf, opencode) are driven by the globally installed skill and reported as such instead of silently doing nothing.
- **ADRs default to Yes in `forge init`** (unless you've globally opted out).
- Added `--copilot/--gemini/--windsurf/--opencode` shorthands to `forge init`; `--all` now covers every offered environment.

## 0.1.4 — 2026-07-20

- **More environments:** install targets now cover Claude Code, Cursor, Codex CLI, GitHub Copilot, Gemini CLI, Windsurf, and opencode — each into its global Agent-Skills (`SKILL.md`) directory. Shorthand flags `--copilot/--gemini/--windsurf/--opencode` added.
- **Select all:** the skills picker defaults to everything on a fresh machine; `a` toggles all in any checkbox.
- **Remembers installs & reconciles:** pickers pre-check what you already have; choosing the full set installs new skill×env pairs and removes deselected ones (`--prune` to force this non-interactively). Flag-scoped runs (e.g. `forge install`) stay additive.
- **ADR path only when relevant:** ADRs enable by picking an ADR skill; the ADR-directory question is skipped entirely when no ADR skill is selected (the standalone "use ADRs?" prompt is gone).

Note: `forge init` project wiring still targets Cursor / Claude Code / Codex — the three with command/rule/hook templates.

## 0.1.3 — 2026-07-20

- **Arrow-key selectors** (same UI as OpenSpec, via `@inquirer/prompts`): skill/environment pickers are checkbox multi-selects (space to toggle, `a` for all), yes/no questions are confirm prompts, the planning-engine choice is a two-option select, and the ADR directory input pre-fills its default. Numbered `1,3`-style menus removed. Ctrl+C exits cleanly (code 130). Non-interactive flags (`--skills`, `--agents`, `--all`) unchanged.

## 0.1.2 — 2026-07-19

- Interactive skill/agent picker: pick **one or more** (e.g. `1,3`) or all; clearer prompt and re-ask on bad input.
- Package README included so npm shows docs on the package page.
- **Forge reference ships with the skill:** `skills/forge/docs/forge.md` → installed as `~/.{cursor,claude,codex}/skills/forge/docs/forge.md`. Commands/rules point there (no missing monorepo `docs/forge.md`).

## 0.1.1 — 2026-07-19

- First installable npm release (`@izkac/forgekit@0.1.1`). `0.1.0` metadata was incomplete on the registry; republish fixed `npm i -g @izkac/forgekit`.
- CI: discover tests without Node 20 glob expansion; bump `actions/checkout` / `setup-node` to v5.

### Session scorecard (L2 measurement)

- **`forge score`**: grades session artifacts (spine, deferrals, product-loop quality, evidence, pace) → JSON/markdown; `--write` saves `scorecard.json` + `scorecard.md`.
- **`forge phase done|finish`**: always writes the scorecard and stamps `session.score` / `session.scoreGrade`. Incomplete finishes are capped at grade ≤ D (59).
- Docs: [usage.md](docs/usage.md) § Session success (L1 process / L2 score / L3 ship-check).

### Docs

- New tutorial: [`docs/usage.md`](docs/usage.md) — install, project wiring, slash commands, simple vs jobs/workers examples, integrity (spine / defer / product loop), cheat sheet.
- **Spine is mandatory** for every Forge change (filled rows or `notApplicable`). No longer inferred from slug/keywords — that miss let hollow platforms skip the matrix.

### Forge runtime integrity — round 2 (product-loop acceptance)

- **Spine matrix**: `forge spine init|check` — per-change `spine.json` mapping capability → library → runtime owner → writes → reads → UI consumer → evidence. Library-only rows fail validation.
- **Deferral registry**: `forge defer add|resolve|list` — "wiring later" must name a registered open task; unresolved deferrals block done. Reviewers reject unregistered deferrals.
- **`forge integrity-check`**: mechanical gate (spine validity, open deferrals, product-loop/BLOCKED evidence) — run automatically by `forge phase finish|done`.
- **E2E redefined as product loop**: producer→consumer→decision-changes-output; a single job slice or library E2E no longer counts. `verify-evidence.md` needs a `## Product loop` section (or explicit BLOCKED, which refuses done).
- **Job-kind closure**: every product-surface job kind wired end-to-end or deleted before complete; "fail closed" is only a temporary BLOCKED state.
- **Consumer–producer rule**: anything UI/API reads must be proven production-written.
- Prompts/phases updated: plan scaffolds the spine; task reviewer rejects unregistered deferrals and library-only spine rows; final reviewer requires product-loop evidence.

### Forge runtime integrity

- Always-on rules: `skills/forge/references/runtime-integrity.md` (no stubs / false success, runtime owner required, tests must fail on a no-op, specs beat narrow tasks, E2E-or-BLOCKED).
- Hardened implementer / task-reviewer / final-reviewer prompts; plan orchestration seam; verify wiring audit + E2E gate.
- Pace `auto` fails closed to **standard** for unrecognized scope; worker/job/queue/pipeline/etl/platform/orchestration/openspec signals → standard; explicit small-work → brisk.
- Task-count escalation: `--tasks-total ≥ 15` upgrades brisk/lite → standard when pace is not pinned.
- `forge phase finish|done` requires `verify-evidence.md` and all tasks complete (escape: `--allow-incomplete "<reason>"`).
- Defaults: `integrity.forbidStubs`, `specsBeatNarrowTasks`, `requireE2E`; session reminders inject integrity line.
- **Upgrade:** re-run `forgekit install --skills forge --force` on each machine to pick up skill changes.

## 0.1.0 — 2026-07-18

Initial public release of `@izkac/forgekit` (npm name; `@forgekit/cli` is taken by an unrelated project).

- Portable skills: Forge, thorough-code-review, archive-to-adr, git-resolve-adr-conflict
- Optional OpenSpec planning engine with built-in `specs/` fallback
- Optional ADR scaffolding (`docs/adr` by default)
- Selective `forgekit install` / `list` / `update` / `uninstall`
- `forge` session CLI + `review` thorough-review pipeline
- Published package vendors `skills/` + `templates/` via `prepack`
