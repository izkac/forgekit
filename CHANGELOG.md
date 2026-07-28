# Changelog

## Unreleased

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
