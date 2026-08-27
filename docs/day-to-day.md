# Forge day to day

How to actually use Forge during a normal work week. This is the operator's
view: what you type, what the agent does, and which knobs matter. Full
reference: [usage.md](usage.md) (install, integrity internals, scoring) and
[forge.md](forge.md) (workflow internals).

**One thing to understand first:** most `forge` CLI commands are run *by the
agent*, not by you. Your day-to-day surface is small:

| You | The agent |
|-----|-----------|
| Chat: `/forge`, `/forge:apply`, `/forge:skip`, plain requests | `forge new`, `forge phase`, `forge spine`, `forge e2e run`, reviews |
| `forge status`, `forge brief open`, `forge fleet …` | `forge resolve-model`, `forge integrity-check`, `forge score` |
| `forge prefs`, `forge models`, `forge e2e disable` | everything else |

---

## 1. The 30-second mental model

Forge turns "write me a feature" into a tracked pipeline:

```
triage → brainstorm → plan → implement → verify → review → finish
```

- **Triage** — is this big enough to deserve the pipeline? Small stuff skips it.
- **Brainstorm** — the agent proposes an approach; you approve it.
- **Plan** — a tracked change is written (spec + tasks), plus a plain-language
  **operator brief** (`brief.html`) — that brief is what you actually review.
- **Implement** — one subagent per task group, test-first, with code reviews.
- **Verify / review** — tests run for real, a final reviewer reads the whole diff.
- **Finish** — the change is archived and an integrity gate (`forge phase done`)
  refuses if anything was faked, stubbed, or left unwired.

Your job is the approval points (approach, brief) and reading `forge status`.
The gates do the nagging so you don't have to.

---

## 2. Starting work — three ways

### a) Just describe the task (most days)

```text
Add rate limiting to the public API. 100 req/min per key.
```

The agent does the work directly. Forge does **not** start unless you invoke it.

### b) Start Forge

```text
/forge add rate limiting to the public API
```

or:

```text
Use Forge. Add rate limiting to the public API. 100 req/min per key.
```

Triage is still the first step: a feature or logic-changing bug fix continues
the pipeline (`forge new …`, brainstorm). A typo, rename, or question may still
execute directly. If it's ambiguous the agent asks one question: "would this
produce a tracked change?"

### c) Force Forge off (this task only)

```text
/forge:skip just rename that config field
```

The work runs directly, no session, no ceremony. Use it freely for small
things — Forge for a one-line change is waste, and the tooling agrees: even
mid-Forge, a small plan (≤5 tasks, one capability, low-risk) triggers an
**exit ramp** where the agent offers to leave Forge before scaffolding specs.

**Using Cursor, Codex, Copilot, Gemini, or OpenCode?** Pick that harness at
`forgekit install` — the skill lands once at `~/.agents/skills/forge/`. There
is no `--shared` flag and no separate shared target. Claude still needs
`--claude`. `forge init --agents` is gone: it errors and points at install. A
leftover stamped project copy is a `forge doctor` warning and is retired by
`forge init`. What you don't get from the skill alone: no slash commands and
no hooks — start work by asking for Forge by name ("use Forge …"). Cursor
still gets commands/rules/hooks via `forge init --cursor`.

---

## 3. A feature, start to finish (what you'll see)

Say you typed `/forge add CSV export to the reports page`.

**1. Announcement.** The agent says `Using Forge for this work. Pace: auto →
standard (…)`. If the pace looks wrong for the job, say so now (see §4).

**2. Brainstorm.** You get 2–3 approaches with trade-offs. Reply with which
one, or just "go" if the first is fine. No code is written before you approve —
that's a hard gate.

**3. Plan + brief.** The agent writes the tracked change
(`specs/changes/add-csv-export/` or `openspec/changes/…`: proposal, tasks,
`spine.json`) and an operator brief. Open it:

```bash
forge brief open      # plain-language: what you get, how it works, risks, out of scope
```

The brief is your review surface — approve *that*, not the raw specs.
Implementation refuses to start while the brief is missing or stale.

**4. Implement.** Say "apply" or `/forge:apply`. Subagents work through
`tasks.md` test-first; reviewers check each group. You can walk away — check
back with:

```bash
forge status     # phase, tasks 4/9, pace, health: healthy | stale | red | done
```

**5. Verify + final review.** Tests run for real (evidence is stamped, not
claimed). On OpenSpec projects with `openspec-verify-change` installed, Forge
sweeps leftovers (docs, missed files, naming) and fixes them before the
independent reviewer reads the whole session diff. On small low-risk changes
verify + review collapse into one "closer" pass — the leftover sweep still
runs first.

**6. Finish.** The change is archived, `forge phase done` runs the integrity
gate and writes a scorecard. If it refuses, see §6.

---

## 4. Pace — how much ceremony you get

Pace controls review depth and verify cost. Default is `auto`, which resolves
from the task itself and re-resolves at plan time when real numbers (task
count, spine rows) are known.

| Pace | Feel | Reach for it when |
|------|------|-------------------|
| `thorough` | reviews per group, 3 fix rounds | money/auth work you're nervous about |
| `standard` | reviews per group, 2 fix rounds | the sane default |
| `brisk` | spec-only reviews, faster models | small UI tweaks, isolated fixes |
| `lite` | minimal everything | scaffolding, doc-heavy changes |

```bash
forge prefs                       # what's in effect right now (writes nothing)
forge prefs --session-set brisk   # this session only
forge prefs standard              # this checkout, permanently (gitignored file)
```

Or just say it in chat: `Pace: brisk` in your task message works.

Two floors you can't lower, on purpose: high-risk tasks (money, auth,
contracts, migrations) always get per-task review and an independent final
review, on every pace. And `auto` fails *closed* — an unrecognized task
resolves to `standard`, never to `brisk`.

---

## 5. Small change vs platform change

**Small, synchronous change** (an endpoint, a UI feature): the flow in §3 is
all there is. `spine.json` still exists but says `notApplicable` — one honest
line, not a matrix. Ceremony auto-collapses (combined closer pass).

**Platform change** (workers, job queues, pipelines, "UI waits on an async
job"): the spine gets one row per capability naming who *runs* the code in
production, and the product loop must be **executed, not described** — the
agent authors `e2e.json` steps at plan time and `forge e2e run` has to go
green before the session can finish. This is the expensive part of Forge and
the reason it exists: it catches "library written, nothing calls it".

The only command you personally might run here is the off switch:

```bash
forge e2e disable "slow legacy stack — manual verification accepted"
forge e2e enable
```

That's operator-only by design — agents are forbidden from running it. Details
and a full worked example: [usage.md §6](usage.md).

---

## 6. When Forge refuses — what it means

Gates fail with a named reason. The common ones, in plain words:

| Refusal | Meaning | Your move |
|---------|---------|-----------|
| brief missing/stale | specs changed after you approved the brief | agent rewrites + re-stamps; re-read it |
| spine missing | nobody said who runs this code in production | agent fills rows or `notApplicable` |
| unresolved deferrals | "wire it later" was promised, later never came | agent finishes the wiring, or it stays open debt |
| e2e missing/red/stale | product loop never ran green (or steps changed after the run) | agent re-runs; or `BLOCKED` with the reason |
| final review missing | high-risk change with no independent reader | let it dispatch a reviewer, or waive with a recorded reason |
| change not archived | finish step skipped | `forge change archive <name>` / `openspec archive` |

Every gate has a recorded escape hatch (`--allow-incomplete "<reason>"`,
`--final-review-waived "<reason>"`) — they cap the score and go in the durable
ledger, so use them when true, not when inconvenient.

---

## 7. Several things at once — the fleet

Every Forge session on your machine, across all projects and editors, shows up
in one place:

```bash
forge fleet list                       # all sessions: phase, tasks, age
forge fleet watch                      # live view of active ones
forge fleet view checkout-flow --transcript 20   # tail a session's conversation
forge fleet send checkout-flow "pause and give me a status report"
```

`send` is delivered on the session's next agent turn — an idle session won't
see it until you poke that window. When two live sessions share one project,
both agents get warned so you can pick: continue, worktree, or pause one.

---

## 8. Options you'll actually touch

**Per project** (`.forge/config.json`, written by `forge init`):

| Key | Values | What it changes |
|-----|--------|-----------------|
| `plan.engine` | `openspec` \| `specs` | OpenSpec CLI vs built-in `specs/changes/` — same layout either way |
| `git.checkpoint` | `off` (default) \| `per-group` | lets the agent commit at task-group boundaries (never pushes, refuses on the default branch) |
| `adr.enabled` | `false` \| `true` | archive→ADR step at finish |

**Per checkout** (gitignored, only exist after you set them):

```bash
forge prefs brisk        # .forge/preferences.local.json — pace
forge models metered     # .forge/models.local.json — subagent billing
```

`forge models` matters for cost: `included` (default) keeps subagents on your
subscription pool; `metered` sends them to API billing. Agents must resolve
models through `forge resolve-model` and never hand-pick — if a subagent ever
bills you unexpectedly, that contract was broken; `forge analyze` shows the
skip rate.

**Health check anytime:** `forge doctor` (engine wiring), `forgekit list`
(installed skill versions — a stale global install looks exactly like a bug).

---

## 9. After it ships

```bash
forge score --md        # A–F grade: process, artifacts, review depth
forge analyze           # across sessions: tokens, models, policy skip rate
forge fleet report      # cross-project trend
forge cleanup           # prune finished session scratch (ledgers survive)
```

The scorecard ends with the question that actually matters (**L3**): *could
you ship this to a customer tomorrow?* If the gates were green but the answer
is no, that's a Forgekit bug — file it against Forge, not just the product.

Anything noticed along the way that was out of scope lives in the findings
ledger, not in a report nobody re-reads:

```bash
forge finding list
forge finding add "export ignores timezone" --kind bug --severity major
```

---

## 10. Cheat sheet

```text
# In chat
/forge <task>            start Forge (or say “use Forge”)
/forge:skip <task>       do it directly, no ceremony
/forge:apply [<change>]  implement an approved plan
/forge:status            progress
/forge:harness           build + record the project e2e harness ahead of need
/forge:analyze           improvement report over recent sessions
Pace: brisk              inline pace override in any task message
```

```bash
# In a terminal
forge status                     # where is it, is it healthy
forge brief open                 # read what you're approving
forge prefs [pace]               # ceremony dial
forge models [included|metered]  # subagent billing lane
forge fleet list|watch|send      # all sessions, all projects
forge e2e disable "<reason>"     # operator-only e2e off switch
forge doctor                     # is the project wired right
```
