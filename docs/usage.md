# How to use Forgekit

Step-by-step guide for humans. Reference details live in
[`skills/forge/docs/forge.md`](../skills/forge/docs/forge.md) (workflow internals; also at `docs/forge.md`) and
[`docs/thorough-code-review.md`](thorough-code-review.md) (standalone review).

**What you get**

| Bin | You use it for |
|-----|----------------|
| `forgekit` | Install skills onto Cursor / Claude Code / Codex |
| `forge` | Run the Forge workflow (sessions, integrity, project wiring) |
| `review` | Standalone thorough code review (not part of Forge apply) |

---

## 1. Install once (per machine)

Needs **Node 20+**.

```bash
npm i -g @izkac/forgekit

# Interactive (TTY): pick skills, agents, planning engine, ADRs
forgekit install

# Or non-interactive — typical Cursor + Claude setup:
forgekit install --skills forge,thorough-code-review --agents cursor,claude --force

forgekit list    # confirm installed / missing / outdated
```

What this does:

- Copies skills into `~/.cursor/skills/`, `~/.claude/skills/`, and/or `~/.codex/skills/`
- Saves your defaults in `~/.forgekit/config.json` (planning engine, ADR preference)

**Without a global install** (one-shot):

```bash
npx @izkac/forgekit install --skills forge --agents cursor --force
```

After you change skills upstream, refresh:

```bash
forgekit install --skills forge --force
# or: forgekit update
```

---

## 2. Wire each project once

From the **project repo** (not the forgekit clone):

```bash
cd /path/to/your-project

# Cursor + Claude Code (slash commands, rules, hooks, .forge/)
forge init --cursor --claude

# Optional: ADRs
forge init --cursor --claude --adr

# Planning engine:
#   - If openspec/config.yaml exists → OpenSpec (silent)
#   - Else uses install default, or asks Planning engine? when unset
#   - OpenSpec choice always writes plan.engine=openspec (setup is best-effort)
#   - Pass --no-openspec → built-in specs/ engine
#   - Pass --plan-dir openspec with --no-openspec to reuse an OpenSpec tree
forge init --cursor --claude --no-openspec   # force specs engine
forge init --cursor --claude --no-openspec --plan-dir openspec
forge init --cursor --claude --openspec      # force OpenSpec path
```

Check readiness:

```bash
forge doctor
# specs engine → checks specs/ layout
# openspec engine → checks openspec/config.yaml + openspec on PATH
```

You should now have:

```
your-project/
  .forge/
    config.json          # plan.engine, optional adr.*
    README.md
  .cursor/commands/      # /forge, /forge:apply, …  (if --cursor)
  .claude/commands/      # same for Claude Code
```

Hooks call `forge` on PATH. If SessionStart reminders do not appear, merge the
generated `forge-hooks.snippet.json` into your agent settings (see init output).

---

## 3. Day-to-day: first feature (Cursor / Claude)

### 3a. Ask the agent to start Forge

In chat (Cursor or Claude Code):

```text
/forge add a health endpoint that returns { ok: true }
```

Or without a slash (Codex / freeform):

```text
Use Forge. Add a health endpoint that returns { ok: true }.
```

What happens:

1. Agent **triages** — substantial → enters Forge; typo/question → may skip
2. `forge new <slug>` creates `.forge/sessions/…` and sets active session
3. **Brainstorm** → you approve the approach
4. **Plan** → OpenSpec `/opsx:propose` or `forge change new` (specs engine)
5. **Operator brief** — the agent writes `brief.html` and tells you where it
   is: plain-language explanation of what will be built (see §4); open it with
   `forge brief open`
6. You approve — the brief is your review surface; specs are the contract
7. **`/forge:apply`** (or `/forge:build`) — subagent per task, TDD, reviews
8. **Verify** → **review** → archive → `forge phase done`

Skip Forge for this turn only:

```text
/forge:skip just rename that label
```

### 3b. Useful slash commands

| You type | Effect |
|----------|--------|
| `/forge` | Resume current phase |
| `/forge:brainstorm` | Brainstorm only |
| `/forge:plan` | Propose the tracked change |
| `/forge:apply` | Implement + verify + review (preferred) |
| `/forge:build` | Implement from `tasks.md` |
| `/forge:status` | Progress (or run `forge status`) |
| `/forge:harness` | Build/verify + record the project e2e harness proactively |
| `/forge:analyze` | Agent-written improvement report over recent sessions |
| `/forge:skip` | Opt out of Forge for this task |

### 3c. Check progress yourself

```bash
forge status
# → session id, phase, tasksComplete/tasksTotal, pace, integrity defaults
```

Example output shape:

```json
{
  "status": "ok",
  "session": { "phase": "implement", "openspecChange": "add-health-endpoint", "tasksComplete": 2, "tasksTotal": 4 },
  "pace": { "requested": "auto", "resolved": "standard", "reason": "…" },
  "integrity": { "forbidStubs": true, "specsBeatNarrowTasks": true, "requireE2E": "when-jobs-or-workers" }
}
```

---

## 4. Operator brief — understand the plan at a glance

Specs (`proposal.md` / `tasks.md`) are written for agents. The **operator
brief** is the translation for you: one self-contained
`changes/<name>/brief.html` in plain language — TL;DR, what you'll get, how it
works (mermaid diagrams), what changes for you, risks, out of scope, work
overview. The agent writes it at the end of every plan phase (both engines);
`forge brief stamp` then records a hash of the specs into it and prints where
it lives — that's the document you approve. Nothing opens automatically
(re-stamps are frequent); `forge brief open` launches it when you want it.

```bash
forge brief check    # fresh | missing | unstamped | stale (exit 1 unless fresh)
forge brief open     # open in your browser, anytime
forge brief stamp    # after (re)writing — stamp freshness (never auto-opens)
```

**Hard gate:** `forge phase implement` refuses while the brief is missing or
**stale** (specs edited after stamping → the agent must update the brief and
re-stamp). Sessions without a tracked change (direct/throwaway) are exempt.
Deliberate waive: `forge phase implement --allow-incomplete "<reason>"`
(recorded as `briefSkipped`).

The brief archives with the change, so `changes/archive/…` keeps the
human-readable record of what was approved — useful input for archive→ADR.

---

## 5. Example A — simple change (sync only)

A small API or UI feature with **no** async jobs.

**You**

```text
/forge Add GET /health that returns JSON { "ok": true }. Include a Vitest test.
Pace: standard
```

**Plan — spine is still mandatory** (honest opt-out):

```bash
forge spine init
```

```json
{
  "change": "add-health-endpoint",
  "notApplicable": "sync HTTP only — no async producer/consumer loop",
  "rows": []
}
```

Do **not** skip `spine.json`. Missing spine fails at `forge phase done` even for
simple changes — that is intentional (keyword sniffing used to miss platforms).

**Agent flow (what you should see)**

1. Brainstorm → you say “go”
2. Plan creates e.g. `openspec/changes/add-health-endpoint/` + spine above
3. `/forge:apply` walks tasks (TDD + review + evidence)
4. Verify + final review
5. Archive; `forge phase done`; cleanup

---

## 6. Example B — platform change (jobs / workers)

Any change with workers, job queues, pipelines, ETL, or “UI waits on async job.”

### 6a. Start with an explicit apply message

```text
/forge:apply etl-surveydb-pipeline-closure
Pace: standard
```

Integrity rules load from Forge defaults — no long DoD paste required.

### 6b. Plan: scaffold the spine (always — fill rows for this case)

```bash
forge spine init
# Creates openspec/changes/<name>/spine.json (or specs/changes/<name>/spine.json)
```

Edit to one **row per capability** (not per library file). Do not use
`notApplicable` here — that would hide the async loop.

```json
{
  "change": "etl-surveydb-pipeline-closure",
  "notApplicable": null,
  "rows": [
    {
      "capability": "REQ-GOV-01 matching",
      "library": "services/etl-core/src/etl_core/matcher.py",
      "runtimeOwner": "worker job analyze_study",
      "writes": "study_proposals",
      "reads": "N/A",
      "uiConsumer": "Proposals page",
      "evidence": "tasks/12-analyze/test-evidence.md"
    },
    {
      "capability": "REQ-OUT-BI",
      "library": "services/etl-core/src/etl_core/bi_star.py",
      "runtimeOwner": "worker job harmonization_run",
      "writes": "runs/<id>/bi/*.parquet",
      "reads": "decisions tip",
      "uiConsumer": "Runs download",
      "evidence": "verify-evidence.md#product-loop"
    }
  ]
}
```

Validate anytime:

```bash
forge spine check
# exit 0 only when every cell is filled (no <placeholders>)
```

Spine rows → also scaffold the executable acceptance steps now (they are a
plan deliverable; see 6d):

```bash
forge e2e init
# Creates e2e.json next to spine.json — author the loop as commands
```

### 6c. Implement: defer only when registered

Wrong (will be rejected by reviewers / fail at done):

> “Library done; wire in §9 later.”

Right:

```bash
forge defer add --task 9.7 --reason "analyze_study handler lands in task 9.7"
# … after 9.7 is implemented and spine row filled:
forge defer resolve --task 9.7
forge defer list
```

### 6d. Verify: run the product loop — prose no longer counts

When the spine has rows, the closed loop is **executed**, not described.
Author the steps at plan time (`forge e2e init` → `e2e.json` next to
`spine.json`), then in verify:

```bash
forge e2e run    # executes steps, writes .forge/sessions/<id>/e2e-results.json
```

E2E is the most time-consuming part of a session. If a project genuinely
can't afford it, **you** (never the agent) can switch it off project-wide:

```bash
forge e2e disable "slow legacy stack — manual verification accepted"
forge e2e enable    # restore the executed-run requirement
```

While disabled, integrity gates stop demanding green runs and the scorecard
grades the product loop from evidence prose only (noted on every scorecard).

```json
{
  "change": "etl-pipeline-closure",
  "notApplicable": null,
  "steps": [
    { "name": "ingest", "cmd": "node scripts/e2e/ingest-fixture.mjs OP1086" },
    { "name": "analyze", "cmd": "node scripts/e2e/run-analyze.mjs", "expect": "proposals: [1-9]" },
    { "name": "ratify", "cmd": "node scripts/e2e/ratify-subset.mjs" },
    { "name": "run-assert", "cmd": "node scripts/e2e/assert-output-differs.mjs" }
  ]
}
```

Every step must exit 0 (and match `expect` when set). Results carry a hash of
the steps — editing `e2e.json` after a green run makes the results stale, and
the done gate demands a re-run. Steps must assert **domain side effects**: a
step list that would pass against a stubbed handler is invalid, and reviewers
reject it. Keep a short `## Product loop` narrative in `verify-evidence.md`
as reviewer context (the gate checks the executed results, not the heading).

If you cannot run E2E here, say so in `verify-evidence.md`:

```markdown
## Product loop

BLOCKED: Compose + fixture corpus not available in this environment.
Need: docker compose up + fixtures/op1086 on the CI runner.
```

`BLOCKED` keeps the change **honest but not done** — `forge phase done` refuses
until unblocked or you explicitly:

```bash
forge phase done --allow-incomplete "E2E blocked until CI Compose fixtures land"
```

### 6e. Finish

```bash
forge integrity-check   # preview problems
forge score             # preview L2 grade (optional)
forge phase done        # integrity gate + writes scorecard.md/json
forge cleanup           # prune finished sessions (optional)
```

Typical failure messages:

```text
Cannot enter phase "done":
  - unresolved deferrals: 9.7 (…) — resolve via forge defer resolve --task <id>
  - spine: row 1 (REQ-GOV-01): runtimeOwner still has scaffold placeholder
  - e2e-results.json missing — run forge e2e run (a green run is required before done)
```

---

## 7. Fleet control terminal — all sessions, one place

Every forge session on the machine — any project, any engine (terminal,
Claude Desktop, Cursor, …) — auto-registers into `~/.forgekit/fleet/` the
moment it touches a `forge` command. One terminal sees and commands them all:

```bash
forge fleet list      # every session: phase bar, task bar, engine, age, ✉ pending
forge fleet watch     # live-refreshing, active sessions only (--all for done/missing)
forge fleet view <session>              # detail; --transcript N tails the
                                        # Claude Code conversation live
forge fleet send <session> "message"    # delivered on the session's next turn
forge fleet send --all "status report"  # broadcast
```

`<session>` matches by slug, session id, or project name (must be unique).

Sessions heartbeat on every agent turn (the AGE column reflects real activity),
and when a session starts or resumes in a project that already has another live
session, both agents are warned — the new one in its session-start context, the
existing one via its inbox — so you can decide: continue, use a git worktree,
or pause one.

Example `list` output:

```text
PROJECT     SESSION            ENGINE  PHASE                TASKS          PACE      AGE  MSGS
mobile-app  push-notifications claude  █░░░░░░ brainstorm   —              standard  2m
shop-api    checkout-flow      claude  ███░░░░ implement    █████░░░ 7/12  thorough  now  ✉ 1
```

How messaging works: `send` drops a file into the session's
`.forge/sessions/<id>/inbox/`; the session-reminder hook injects pending
messages into the agent's next turn (exactly once) under *"Fleet messages from
the control terminal"*. Honest limit: a session only sees a message when it
takes a turn — an idle session with no prompt pending stays silent until you
poke it in its own window.

Viewing fidelity: Claude Code sessions get a live transcript tail (their
`~/.claude/projects/…` jsonl); other engines show forge status, tasks, and
evidence instead.

---

## 8. Planning engines (pick one per project)

| Engine | When to use | Day-to-day |
|--------|-------------|------------|
| **OpenSpec** | You already use `/opsx:*` or want the OpenSpec CLI | `/opsx:propose` → `/forge:apply` → `/opsx:archive` |
| **specs** (built-in) | No OpenSpec CLI | `forge change new <name>` → edit markdown → `/forge:apply` → `forge change archive <name>` |

Both layouts are the same idea:

```
changes/<name>/
  proposal.md
  design.md      # optional
  tasks.md
  brief.html     # operator brief — mandatory, gates implement (see §4)
  spine.json     # mandatory — rows or notApplicable
  e2e.json       # when spine has rows — executable product-loop steps
```

Specs-engine example:

```bash
forge change new add-export-csv
# edit specs/changes/add-export-csv/proposal.md and tasks.md
# … implement via /forge:apply …
forge change archive add-export-csv
# → specs/changes/archive/YYYY-MM-DD-add-export-csv/
```

---

## 9. Pace and models (optional)

Ceremony amount (reviews / verify depth):

```bash
forge prefs                 # print effective — does NOT write a file
forge prefs standard        # WRITE .forge/preferences.local.json (gitignored)
forge prefs --session-set brisk   # this session only
```

| Pace | Feel |
|------|------|
| `auto` (default) | Resolve from signals; unrecognized → **standard** (fail closed) |
| `thorough` | Review every task |
| `standard` | Review per `tasks.md` group |
| `brisk` / `lite` | Less ceremony (high-risk still reviewed) |

Subagent billing (included vs API):

```bash
forge models                # print only
forge models included       # default — subscription pool
forge models metered        # WRITE .forge/models.local.json — only if you ask
```

---

## 10. Standalone thorough review

Not part of `/forge:apply`. Ask explicitly:

```text
Run a thorough code review on this branch.
```

```bash
review new my-branch --type branch
# … scout / merge / render / export per docs/thorough-code-review.md
```

---

## 11. ADRs (optional)

If you enabled ADRs at install/init:

```bash
forge init --adr
# → docs/adr/ (or your --adr-dir), decisions.md, hooks
```

On finish, when `adr.enabled` is true, the agent follows **archive-to-adr** after
archiving the change. Pending ADR reminders come from project hooks.

---

## 12. Common problems

| Symptom | Fix |
|---------|-----|
| Agent never enters Forge | Say `/forge` or “use Forge”; check triage / `/forge:skip` |
| `forge: command not found` | `npm i -g @izkac/forgekit` and ensure PATH; hooks need `forge` on PATH |
| `forge doctor` fails (OpenSpec) | `npm i -g @fission-ai/openspec` or `forge init --no-openspec` |
| Skills outdated after upgrade | `forgekit install --skills forge --force` |
| `forge phase done` refuses — missing spine | `forge spine init`; fill rows **or** set `notApplicable` (required every change) |
| `forge phase done` refuses — deferrals / e2e | `forge integrity-check`; resolve deferrals; `forge e2e init` + author steps + green `forge e2e run` (or spine `notApplicable` for sync-only) |
| `forge phase done` refuses — stale e2e results | `e2e.json` changed after the last run — re-run `forge e2e run` |
| E2E too slow for this project | Operator runs `forge e2e disable "<reason>"` (agents must never) — `forge e2e enable` restores |
| `forge phase implement` refuses — brief missing/stale | Agent writes/updates `brief.html`, then `forge brief stamp` (or `--allow-incomplete "<reason>"`) |
| Fleet table empty / session missing | Session registers on its first `forge` command; check the project ran `forge new` |
| `forge fleet send` seems ignored | Delivery is next-turn via the reminder hook — idle sessions read it when they wake |
| Session reminder missing | Merge `forge-hooks.snippet.json` from init into agent settings |
| Wrong pace (`brisk` on a big change) | `forge prefs --session-set standard` or ensure `--tasks-total` ≥ 15 |

---

## 13. Session success — did Forge actually work?

Do not treat “tasks complete” or even `integrity-check` 0 as product success.

| Layer | Measures | Command / artifact |
|-------|----------|--------------------|
| **L1** Process | Spine, deferrals, executed product loop | `forge integrity-check` / done gate |
| **L2** Artifacts | Quality of those artifacts + pace/evidence | `forge score` → `scorecard.md` (auto at done) |
| **L3** Outcome | Real product path / ship decision | Human questions in scorecard + golden scenarios |

```bash
forge score           # JSON
forge score --md      # markdown
forge score --write   # save into session dir
```

Grades A–F from ~100 points. `--allow-incomplete` **caps** score at 59.
`forge phase done` always writes `scorecard.md` / `scorecard.json` and sets
`session.score` / `session.scoreGrade`.

**After done — answer the L3 ship-check** (printed in the scorecard):

1. Name the production path for the main REQ  
2. Exercise it — real data in UI, not empty queues?  
3. Governance in scope → does ratify change the next run’s output?  
4. Ship to a customer tomorrow? (`yes` / `no` / `follow-on`)

If L1 is green and (4) is `no`, **Forge failed** — open a Forgekit issue, don’t
only file a product bug.

Trend over time: rate of sessions with L1 green + ship=`no` should fall.

## 14. Cheat sheet

```bash
# Machine
npm i -g @izkac/forgekit
forgekit install --skills forge --agents cursor,claude --force

# Project
cd your-project && forge init --cursor --claude
forge doctor

# Session
forge new my-feature --signal "add worker job queue"
forge status
forge brief stamp && forge brief check
forge spine init && forge spine check
forge e2e init && forge e2e run && forge e2e check
forge defer add --task 3.2 --reason "wire handler in 3.2"
forge defer resolve --task 3.2
forge integrity-check
forge score --write
forge phase done
forge cleanup

# Fleet (any terminal, all projects)
forge fleet list
forge fleet watch
forge fleet view my-feature --transcript 20
forge fleet send my-feature "pause and report"
```

In the agent:

```text
/forge …
/forge:apply <change-name>
/forge:status
/forge:skip …
/forge:harness    # build/verify + record the project e2e harness proactively
/forge:analyze    # agent-written improvement report over recent sessions
```

---

## Where to go next

| Doc | Contents |
|-----|----------|
| [usage.md](usage.md) | Tutorial + session success (L1/L2/L3) |
| [forge.md](forge.md) | Full reference: phases, pace matrix, integrity rules, agent surfaces |
| [runtime-integrity.md](../skills/forge/references/runtime-integrity.md) | Hard rules agents must follow |
| [thorough-code-review.md](thorough-code-review.md) | Standalone `review` pipeline |
| [README.md](../README.md) | Package layout, install flags, developing forgekit |
