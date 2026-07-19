# How to use Forgekit

Step-by-step guide for humans. Reference details live in
[`docs/forge.md`](forge.md) (workflow internals) and
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
#   - Else init offers to install OpenSpec CLI + `openspec init`
#   - Decline (or pass --no-openspec) → built-in specs/ engine
forge init --cursor --claude --no-openspec   # force specs engine
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
5. You approve `proposal.md` / `tasks.md`
6. **`/forge:apply`** (or `/forge:build`) — subagent per task, TDD, reviews
7. **Verify** → **review** → archive → `forge phase done`

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

## 4. Example A — simple change (sync only)

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

## 5. Example B — platform change (jobs / workers)

Any change with workers, job queues, pipelines, ETL, or “UI waits on async job.”

### 5a. Start with an explicit apply message

```text
/forge:apply etl-surveydb-pipeline-closure
Pace: standard
```

Integrity rules load from Forge defaults — no long DoD paste required.

### 5b. Plan: scaffold the spine (always — fill rows for this case)

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

### 5c. Implement: defer only when registered

Wrong (will be rejected by reviewers / fail at done):

> “Library done; wire in §9 later.”

Right:

```bash
forge defer add --task 9.7 --reason "analyze_study handler lands in task 9.7"
# … after 9.7 is implemented and spine row filled:
forge defer resolve --task 9.7
forge defer list
```

### 5d. Verify: product loop, not a thin job smoke

In `.forge/sessions/<id>/verify-evidence.md` include a **`## Product loop`**
section. Example:

```markdown
# Verify evidence — tier 3

- **Workspaces:** etl-core, api, web
- **Command:** `pytest services/etl-core && npm test --workspace=api`
- **Exit code:** 0

## Product loop

Fixture: OP1086 three sources

1. ingest_source ×3 → study_sources + Parquet
2. analyze_study → study_proposals non-empty (match / loop)
3. ratify subset via API → decisions tip at revision R
4. harmonization_run @R → .sav + Master QML + BI parquet
5. Assert: artifact hash / columns at R differ from unratified baseline
```

If you cannot run E2E here:

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

### 5e. Finish

```bash
forge integrity-check   # preview problems
forge phase done        # same checks; exit 1 if spine/deferrals/loop fail
forge cleanup           # prune finished sessions (optional)
```

Typical failure messages:

```text
Cannot enter phase "done":
  - unresolved deferrals: 9.7 (…) — resolve via forge defer resolve --task <id>
  - spine: row 1 (REQ-GOV-01): runtimeOwner still has scaffold placeholder
  - verify-evidence.md has no "Product loop" section — …
```

---

## 6. Planning engines (pick one per project)

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
  spine.json     # mandatory — rows or notApplicable
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

## 7. Pace and models (optional)

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

## 8. Standalone thorough review

Not part of `/forge:apply`. Ask explicitly:

```text
Run a thorough code review on this branch.
```

```bash
review new my-branch --type branch
# … scout / merge / render / export per docs/thorough-code-review.md
```

---

## 9. ADRs (optional)

If you enabled ADRs at install/init:

```bash
forge init --adr
# → docs/adr/ (or your --adr-dir), decisions.md, hooks
```

On finish, when `adr.enabled` is true, the agent follows **archive-to-adr** after
archiving the change. Pending ADR reminders come from project hooks.

---

## 10. Common problems

| Symptom | Fix |
|---------|-----|
| Agent never enters Forge | Say `/forge` or “use Forge”; check triage / `/forge:skip` |
| `forge: command not found` | `npm i -g @izkac/forgekit` and ensure PATH; hooks need `forge` on PATH |
| `forge doctor` fails (OpenSpec) | `npm i -g @fission-ai/openspec` or `forge init --no-openspec` |
| Skills outdated after upgrade | `forgekit install --skills forge --force` |
| `forge phase done` refuses — missing spine | `forge spine init`; fill rows **or** set `notApplicable` (required every change) |
| `forge phase done` refuses — deferrals / product loop | `forge integrity-check`; resolve deferrals; add `## Product loop` (or use `notApplicable` for sync-only) |
| Session reminder missing | Merge `forge-hooks.snippet.json` from init into agent settings |
| Wrong pace (`brisk` on a big change) | `forge prefs --session-set standard` or ensure `--tasks-total` ≥ 15 |

---

## 11. Cheat sheet

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
forge spine init && forge spine check
forge defer add --task 3.2 --reason "wire handler in 3.2"
forge defer resolve --task 3.2
forge integrity-check
forge phase done
forge cleanup
```

In the agent:

```text
/forge …
/forge:apply <change-name>
/forge:status
/forge:skip …
```

---

## Where to go next

| Doc | Contents |
|-----|----------|
| [forge.md](forge.md) | Full reference: phases, pace matrix, integrity rules, agent surfaces |
| [runtime-integrity.md](../skills/forge/references/runtime-integrity.md) | Hard rules agents must follow |
| [thorough-code-review.md](thorough-code-review.md) | Standalone `review` pipeline |
| [README.md](../README.md) | Package layout, install flags, developing forgekit |
