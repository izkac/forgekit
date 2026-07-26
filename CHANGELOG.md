# Changelog

## Unreleased

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
