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

Every bin reports the version of the package it came from — check this first
when a documented flag or command comes back as unknown, because a stale global
install looks exactly like a missing feature:

```bash
forge --version      # forge 0.3.21
forgekit --version
review --version
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

The harness those steps run against is recorded once per project and reused by
every later session:

```bash
forge e2e harness                     # show what's recorded (agents check this first)
forge e2e harness --set "vite preview + playwright smoke" \
  --start "npm run build && npm run preview" \
  --setup "npx playwright install chromium" \
  --probe "npm run test:e2e" \
  --dir e2e
```

| Field | What it holds |
|-------|---------------|
| `--start` | boots the app under test |
| `--setup` | what **this machine** needs that the repo cannot carry — browsers, drivers, container images, toolchains |
| `--probe` | the command that proves the harness, re-run by the next session's `/forge:harness` |
| `--dir` | where the harness lives in the repo |

`setup` exists because a harness proven in an agent's sandbox is not proven on
your checkout: the agent installs a browser, the probe goes green, and your
first `npm run test:e2e` fails on a runtime nobody wrote down. Forge never
detects tools and never installs anything — but when a loop goes red and a
`setup` is recorded, `forge e2e run` names it as the first thing to suspect, so
a missing browser stops reading as a code regression. Only `--set` is required;
`--start`, `--setup`, `--probe` and `--dir` are optional and print when set.

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
forge fleet sync      # re-register every session under this project's .forge/
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

Resolution is a contract the coordinator can skip, and skipping it is invisible:
the overlay sits there while dispatches keep going out on a remembered tier
model. Claude Code projects can hold the line from the host side — `forge init
--claude` ships `.claude/hooks/forge-model-hook.mjs` and registers it under
`PreToolUse` in the snippet:

- **No `.forge/models.local.json`** → the hook allows everything, always. Nothing
  changes until you opt in.
- **Overlay flattens a lane** (`fast`, `standard` and `capable` all one model) →
  there is no tier left to guess, so dispatches are rewritten to that model.
  Hand-write the lane when you want one model for every subagent.
- **Overlay keeps tiers apart** → the dispatch carries a model but no tier, so
  the hook can only check membership: a model outside the resolved three is
  denied with the table and a pointer back to `forge resolve-model`.

Cursor and Codex have no equivalent dispatch hook; there the resolver stays an
instruction.

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
| `forge checkpoint` says checkpoints are off | Opt in: `.forge/config.json` → `{ "git": { "checkpoint": "per-group" } }` |
| `forge checkpoint` refuses — default branch | Forge work belongs on a branch; create one, or `--allow-default-branch` / `git.allowDefaultBranch: true` |
| `forge phase done` refuses — final review | High-risk change needs an independent final review; dispatch one, or `--final-review-waived "<reason>"` (recorded on the session and in the ledger) |
| Verify passes but the suite is flaky | `forge e2e run --repeat 5 --record-baseline` — a non-zero baseline makes every verify a coin flip |
| A finding keeps reappearing in reports | `forge finding add "<text>" --change <slug>` — then open that change, or mark it `--severity note` |
| Session shows `RED` / `STALE` | `forge status` → `health.reasons`: fix the failing e2e step, re-run `forge e2e run`, or resume the idle phase. Progress for openspec/specs comes from `tasks.md` checkboxes (not a separate counter you must bump by hand). |
| Fleet table empty / session missing | Session registers on its first `forge` command; check the project ran `forge new` |
| `forge fleet send` seems ignored | Delivery is next-turn via the reminder hook — idle sessions read it when they wake |
| Cursor Forge sessions missing from `forge fleet` | Cursor's agent sandbox blocks writes to `~/.forgekit`. Re-run `forge` with unrestricted shell (`required_permissions: ["all"]`), or `forge fleet sync` from a normal terminal. Pending stamps live at `.forge/sessions/<id>/fleet-pending.json`. |
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

Grades A–F from ~100 points. `forge phase done` always writes `scorecard.md` /
`scorecard.json` and sets `session.score` / `session.scoreGrade`.

**Caps** — outcomes outrank artifacts, so three things put a ceiling on the score
no matter how polished the paperwork is:

| Cap | When |
|-----|------|
| 59 | `--allow-incomplete "<reason>"` |
| 69 | Health is `red` — a failing e2e run or BLOCKED verify evidence |
| 69 | High-risk change (money / auth / contracts / migrations, read from the pace signal **and the spine**) without an **independent final review** |

The high-risk read fails closed: a negated mention ("carries consumption, never
money") still counts, because the cost of being wrong is one dispatched
reviewer. Per-group reviews do not lift that cap — each saw one slice; the floor
is an independent reader of the whole change. If dispatch is genuinely refused, record it with
`forge phase done --final-review-waived "<reason>"` — the reason is kept on the
session and in the `sessions.jsonl` digest, so it outlives cleanup alongside the
cap it explains. Do **not** use `forge defer` for this: an open deferral costs
the full 10 deferral points and fails `forge integrity-check`.

**Review depth is scored by what was dispatched**: coverage of independent
reviews across task groups, whether the final review is independent or
self-authored, and whether any round **rejected** work before approving (a
review that sent work back demonstrably was not a rubber stamp).

**Authorship is measured, not read, wherever the host recorded it.** Dispatch
reviewers with the description `forge review-label <unit>` prints — exactly
that, nothing before or after:

```bash
forge review-label final       # → forge-review final <session-id>
forge review-label group-03    # → forge-review group-03 <session-id>
```

Claude Code then writes a record of the subagent it actually ran. The trailing
session id is what makes that record attributable: one Claude Code conversation
routinely hosts several Forge sessions, and without it a neighbour's reviewer
is indistinguishable from this session's own. A dispatch described in the older
two-word form is counted for nobody — Forge reports that it cannot tell, and
reads the review file's wording instead.

**Label the final reviewer. Group labels are optional and buy nothing** —
measured, a session's verdict, score and digest come out identical in every field
(bar wall clock and paths) with and without them, because `final` is the only
unit that decides anything. What a group label *does* do is tell Forge the
convention is in use: once *any* dispatch in a session carries a label, a missing
`final` reads as "no outside reader" rather than "not adopted". On a **high-risk**
change that refuses at `forge phase done`; on any other it records `{self, host}`
in the durable digest and costs a scorecard point for a session that did get an
independent reviewer.

So the safe orders are *label the final reviewer* (group labels then harmless) or
*label nothing*. "Label everything" is only safe while you never forget the one
that counts, and its failure is silent. Where a record exists and the reviewer on
it did some work, `forge phase done` reads it and no wording in the review file
changes the verdict.

**The record proves a dispatch, not a review, and dispatching is cheap.** Earlier
versions of this page said a record could not be produced without really
dispatching a **subagent** and left it there, as though that settled it. It does
not: a throwaway subagent carrying this session's label — one request long,
reading nothing — produced a record that carried a change through the money/auth
gate against a review file stating plainly that no subagent had read it. So since
0.3.34 the host is asked what the dispatch *did*. A unit whose busiest single
dispatch — counting only the ones you did not stop — made fewer than **5
requests** certifies nothing; the verdict falls back to the review file's wording
and grades `inferred`. Being under the floor never refuses on its own — it only
stops vouching.

**But something downstream can.** A verdict graded `inferred` is not protected by
the freeze, so a below-floor session whose sidecar directory is later pruned has
that verdict replaced at `done` by a `self` reading and is refused — even when
its review file plainly reads independent and a reviewer really ran. It is
permanent, because a refused pass writes nothing. If that happens the session is
fine and the gate is wrong: use `forge phase done --final-review-waived "<reason>"`
and say so in the reason. Filed as F49/F52; the fix is in `set-phase.mjs`. The number has a corpus behind it: all 24 labelled review
dispatches on the author's machine (2026-07-30) ran 15 requests at the minimum,
55 median, 173 maximum, none below 15 — and the forgery ran 1.

**Corrected in 0.3.35.** The paragraph above is left as it shipped, and the
refusal it warns about no longer happens the way it describes. The frozen
verdict now also records whether the deciding dispatch was on record *at the
moment it froze* (`unitOnRecord`); a later pass that finds that record gone,
where an earlier pass found it, keeps the frozen verdict instead of replacing
it with a fresh `self` reading. A below-floor session whose sidecar directory
is pruned *after* it froze `independent`/`inferred` no longer gets refused at
`done` for that reason, and does not need `--final-review-waived`.

One narrower case still does: if the sidecar record is already gone the *very
first* time a verdict freezes for a session — nothing measured earlier to
compare against — the census still grades that first reading `self`/`host`
("nothing was dispatched"), and `forge phase done` still refuses, even if a
reviewer genuinely ran and its record simply didn't survive that long. If you
hit that, the session is fine and the gate is wrong: waive it and say so in
the reason. That narrower gap is **F12**'s — Forge stamping the review file
itself when it dispatches the reviewer, so the verdict never depends on
transcript survival at all — and remains open.

This is **not a security boundary** and is not claimed as one. Someone who knows
the floor can pad past it. What it removes is the one-line forgery: faking a
review now costs a subagent that genuinely runs. The real fix is Forge stamping
the review file when *it* dispatches the reviewer, which is filed as F12 and not
done.

Every verdict carries a grade saying how it was reached:

| grade | meaning |
|-------|---------|
| `host` | decided from the host's record of a dispatch **this session labelled**. One caveat, and it is real: it is **not** a promise a matching dispatch was found — a `host` grade with no match is the verdict "no outside reader ran", and that is what refuses at the gate. It is no longer a time-window guess: earlier versions matched dispatches by when they ran, so a session sharing a Claude Code conversation with another could be credited with that session's reviewer. The session id in the description ended that. |
| `inferred` | read from the review file's wording — no host record survives, or none of this session's dispatches carries a label so the convention is not in use here, or the labelled dispatch did too little work to certify anything |
| `none` | there is no final review to judge |

The verdict is **frozen** when the session finishes, because transcripts are
pruned within days; it lands in `session.json` and in the `sessions.jsonl`
digest, so it outlives its own evidence.

On the `inferred` path — Cursor, Codex, a pruned transcript, or a repo that has
not adopted the description — a review is read as independent unless its opening
paragraphs or a `Reviewer:` line declare it a self-check. That is an inference
from absence and is known to over-credit (finding F12), which is why absence of
host evidence **never refuses work**: it falls back, it does not fail closed.

**So head your review files with who wrote them, in one of the phrases Forge
recognises — the list is closed:** `self-check`, `self-review`, `self-audit`,
`self-authored`, `Reviewer: coordinator`, `reviewed by the coordinator`,
`APPROVED (pace …)`, `SKIPPED (pace …)`. Put it in the opening two paragraphs; below that only a line
beginning `Reviewer:` is reliably read, and it still has to carry one of the
phrases. Saying it in your own words, or further down the file, reads as an
outside reader you did not have.

`forge fleet report` will not sum verdicts across grades without saying so — a
measured `independent` and a guessed one are not the same fact.

### Which session a bare command acts on

Every Forge command takes `--session <id>`. Without it, the command resolves one
for you — and until 0.3.30 that resolution read `.forge/active.json`, which is
written by **`forge new` alone**. "Active" therefore meant *most recently
created*, not the one you were working on, so with two sessions open a bare
`forge phase done` could gate the wrong change: scoring it, writing its
permanent ledger line, and leaving the change you were actually finishing with
no verdict and no trip through the money/auth floor.

Now:

- `--session` always wins.
- With one session open, it is used — even if the pointer names a finished one.
- With several open, the pointer decides, and **you are told**:

```
$ forge phase verify
[forge] Warning: 2 sessions are unfinished; acting on 20260729T…-billing (from .forge/active.json).
[forge] To act on another instead:
  --session 20260728T…-search   (search-index, implement)
```

- **Commands that write a permanent record refuse instead of warning**, and
  severity follows what the *invocation* writes rather than what the command is
  called: `forge phase done|finish`, `forge checkpoint` (not `--dry-run` or
  `--range`), `forge score --write`, `forge brief stamp` (not `check`/`open`),
  and `forge review-label`. They exit non-zero and list each candidate as the
  flag that selects it.
- **`forge evidence`** warns and records, but refuses to *overwrite* existing
  evidence for a session it only guessed at — that file feeds the scorecard and
  the durable ledger, and it is not in git.
- **`forge cleanup`** never ages out a session that holds work; scaffolding
  still ages out. `--include-unfinished` deletes work, so it requires `--session <id>`, which
  also scopes the run to that session — and names it even against the pointer's
  own protection, since you typed it after a flag that says it deletes work.
- `forge phase` marks the session it transitioned as active, so the pointer
  follows your work. Not on a *refused* transition, and never on
  `done`/`skipped` — finished work must not capture your status line.
- `forge status` and the session-start reminder report the ambiguity alongside
  their answer rather than presenting a guess as a fact.

**Durable ledgers** — the session dir is deleted at cleanup, so `phase done`
also appends:

| File | Holds |
|------|-------|
| `.forge/scorecards.jsonl` | one score line per session |
| `.forge/sessions.jsonl` | one digest per session: tasks, subagents, reviews by kind, rejections, checkpoints, health, duration, and compact telemetry totals |
| `.forge/deferrals.jsonl` | unresolved deferrals, with the session that owed them |

**After done — answer the L3 ship-check** (printed in the scorecard):

1. Name the production path for the main REQ  
2. Exercise it — real data in UI, not empty queues?  
3. Governance in scope → does ratify change the next run’s output?  
4. Ship to a customer tomorrow? (`yes` / `no` / `follow-on`)

If L1 is green and (4) is `no`, **Forge failed** — open a Forgekit issue, don’t
only file a product bug.

Trend over time: rate of sessions with L1 green + ship=`no` should fall.

---

## 13a. Session telemetry — what a session actually cost

The scorecard measures how *disciplined* a session was. Telemetry measures how it
*ran*: tokens, models, tool failures, subagents and whether the model policy was
honoured. It is a reader, not a recorder — Claude Code already writes every
request to a JSONL transcript, and Forge simply learns which transcripts belong to
which session (from `CLAUDE_CODE_SESSION_ID`, so no hook is required).

```bash
forge metrics collect              # harvest now, into .forge/sessions/<id>/metrics.json
forge metrics collect --json       # the whole document
forge analyze                      # read the ledgers back as numbers
forge analyze --json --since 2026-06-01 --limit 20
```

`forge phase finish|done` collects automatically, just before the scorecard, so a
finished session always leaves its numbers behind.

**What is recorded:** counts, model slugs, tool names, agent types, phase names
and timestamps. **Never** prompt text, model responses, command strings, file
contents, or a subagent's `description`. `metrics.json` is a file that outlives
the conversation; it holds arithmetic, not content.

**`available: false` is normal, not an error.** Running outside Claude Code, or
against a transcript the host has since pruned, records a reason and exits 0.
Telemetry may cost you a measurement; it never costs you a phase transition.

`forge analyze` **states coverage first** — "6 of 9 analysed sessions carry
metrics" — because sessions that predate telemetry still count in grades and
deferrals but contribute no tokens. Per-model token splits come from
`metrics.json` files that still exist; once `forge cleanup` has run, the digest's
totals are what remain, and each model row says how many of its sessions still had
the detail.

**Model policy.** With the `forge enforce-model` PreToolUse hook wired
(`forge init`), every subagent dispatch is logged to
`.forge/sessions/<id>/dispatches.jsonl` and rolled into a skip rate: how often a
dispatch had to be rewritten or refused because `forge resolve-model` was skipped.
A skip rate of zero *with no dispatches recorded at all* means the hook is not
installed — a different finding entirely, and `forge analyze` says which one it is.

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
forge status                      # includes health: healthy | stale | red | done
forge brief stamp && forge brief check
forge checkpoint --group 02-api --tasks 2.1-2.4   # opt-in: .forge/config.json → git.checkpoint
forge checkpoint --range --last   # {DIFF_RANGE} for the group reviewer
forge finding add "smoke suite race is never fixed" --change fix-e2e-race
forge finding list                # open findings (also shown by forge status)
forge fleet report                # cross-project trend (scores, reviews, carried debt)
forge e2e run --repeat 5 --record-baseline   # is the harness baseline actually zero?
forge spine init && forge spine check
forge e2e init && forge e2e run && forge e2e check
forge defer add --task 3.2 --reason "wire handler in 3.2"
forge defer resolve --task 3.2
forge integrity-check
forge score --write
forge phase done                  # also collects metrics + writes the durable digest
forge cleanup

# Telemetry — what a session actually cost
forge metrics collect             # → .forge/sessions/<id>/metrics.json
forge analyze                     # coverage, per-model/phase totals, policy skip rate
forge analyze --json --since 2026-06-01

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
