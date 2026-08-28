# Verify phase

**Ceremony check first:** if `forge status` shows `resolvedCeremony: combined`,
follow [close.md](./close.md) instead of this file and [review.md](./review.md) —
one closer pass covers both. This file is the `full` tail.

Read and follow [../skills/verification-before-completion/SKILL.md](../skills/verification-before-completion/SKILL.md) and [../references/test-strategy.md](../references/test-strategy.md).

## Required checks

### 1. Audit tier 2 evidence (per task)

For each completed task under `.forge/sessions/<id>/tasks/<nn>-<slug>/`:

- `test-evidence.md` exists with command, exit code `0`, and pass summary (or key output lines).
- `task-review.md` shows **APPROVED** (legacy sessions: `spec-review.md` + `quality-review.md`).
- Evidence uses tier 2 scope (narrow) unless the task documented a tier-2 full-workspace exception.

If any task lacks evidence, shows non-zero exit, or reviewers rejected test coverage → **stop** and fix or re-dispatch that task's implementer.

**Do not** re-run tier 2 commands here — audit the artifacts.

### 2. Tier 3 (scope from pace)

After tier 2 audit passes, honor `verify.tier3` from [../references/pace.md](../references/pace.md) / `forge status`:

| `verify.tier3` | Action |
| -------------- | ------ |
| `full-workspace` | One fresh full test per affected workspace (default thorough/standard) |
| `affected-only` | Full test only for workspaces touched by this change |
| `audit-tier2-only` | Do **not** run the suite; record deferral to push/CI in `verify-evidence.md` |

```bash
npm test (affected package/workspace)
```

When contracts changed and tier3 is not `audit-tier2-only`, also run tests in downstream consumer workspaces (project ecosystem-impact policy).

Save to `.forge/sessions/<id>/verify-evidence.md`:

```markdown
# Verify evidence — tier 3

- **Workspaces:** your-workspace, …
- **Command:** `npm test -- path/to/scoped.test.ts`
- **Exit code:** 0
- **Summary:** 142/142 pass (or paste last ~30 lines)
- **Run at:** 2026-06-07T12:00:00Z
```

Cite this file when claiming the implementation passes. Exit code must be `0` before leaving verify.

### 2b. Strict typecheck — enforced at the gate, not here

Tier 3 runs **tests**, and Vitest transpiles without type-checking — so green tests do
**not** prove the code compiles under strict `tsc`. You do **not** need to run the full
build gate to leave verify — strict typecheck is enforced automatically by the `pre-push`
hook (diff-scoped, on every push / launcher **Publish**) and the full typecheck + tests on
`development` by CI. If you want local certainty on the types you touched, optionally run:

```bash
npm run build:packages           # fresh dist/ so dependents resolve current .d.ts
node scripts/agent-check.mjs     # strict typecheck + tests for the diff-affected workspaces
```

— but a clean tier-3 test audit is the bar to leave verify; the Publish/push + CI gate
(`shared-build-gate` capability) catches any strict-mode breakage before it's shared.

### 3. Runtime wiring audit

Honor [../references/runtime-integrity.md](../references/runtime-integrity.md).

For each requirement in the change's **capability specs** (not only `tasks.md`):

- Name the **production caller** (job kind, endpoint, CLI, …) that invokes the implementing code.
- Library-only / stub handler / false success / enqueueable-but-unhandled kind → **stop**. Add wiring or mark explicit gaps; do not advance.

Record the trace in `verify-evidence.md` (a short REQ → caller table is enough).

### 4. Product-loop E2E — executed, or BLOCKED

Before leaving verify / claiming the change complete:

1. Confirm `e2e.json` (scaffolded at plan time via `forge e2e init`) drives the **closed product loop** — not a single job slice. When the design has a producer/consumer split (analyze vs execute, proposals vs ratify), the loop is: produce artifact → consumer reads it → decision/state change → **next run's output differs from baseline**. Steps must assert domain side effects; a step list that would pass against a stubbed handler is invalid.
2. `forge e2e run` — executes the steps sequentially and writes `e2e-results.json` (per-step exit codes, output tails, steps hash) into the session dir. A **green run** is required; results go stale if `e2e.json` changes afterwards (re-run). Prose in `verify-evidence.md` no longer satisfies the done gate. **Or**
3. Leave an explicit **`BLOCKED`** list in `verify-evidence.md` explaining why E2E cannot run here — the done gate then refuses `done` until unblocked or the user signs `--allow-incomplete`. (`e2e.json` `notApplicable` is only for loops no command can drive — reviewers police the reason.)

Keep a short loop narrative under `## Product loop` in `verify-evidence.md` as reviewer context — the gate checks the executed results, not the heading.

Also enforce **job-kind closure**: every product-surface job kind is wired end-to-end or deleted from enums/API/UI before complete. And the **consumer–producer rule**: anything the UI/API reads must be proven written by the production path.

Do **not** mark the change complete or advance to `done` while a critical path is stubbed, unwired, or unverified without `BLOCKED`. Green unit/tier-3 suites alone are not enough when jobs/workers/orchestration are in scope (`integrity.requireE2E`).

### 5. Mechanical gate

```bash
forge spine check        # every capability row wired (library → runtime owner → writes → evidence)
forge e2e check          # green, current e2e-results.json (steps hash matches e2e.json)
forge defer list         # no unresolved deferrals
forge integrity-check    # combined; forge phase done runs the same checks
```

`forge integrity-check` also enforces the test-tamper guard and (for sessions
carrying `features.tddEvidence`) the red→green pairing gate: a guarded test
tracked at `baseCommit` and modified, deleted, or renamed with no recorded
allowance refuses here, on every host — hooked or not, since this check reads
`git diff` directly rather than depending on the `PreToolUse` hook. That same
`git diff` scoping means the integrity-artifact rule only ever fires for
artifacts **committed** at a change-dir location (e.g.
`openspec/changes/<name>/spine.json`) — an artifact living only under the
gitignored `.forge/sessions/<id>/` is untracked and invisible to this check no
matter how it was edited; the hook is the real defense there. A completed
task missing an ok `forge tdd run --expect fail` stamp chronologically before
its ok `--expect pass` stamp — with no `--no-tdd` declaration in its
`test-evidence.md` — also refuses here. A session that tampered with its own
tracked tests cannot reach `done` by skipping the hook.

Fix any failure before proceeding — `forge phase done|finish` refuses on the same problems.

### 6. Plan completeness

- Confirm every plan task is marked complete.
- Confirm no tier 2 evidence contradicts another.
- For OpenSpec: `openspec instructions apply --change "<name>" --json` shows expected progress.
- Requirements met = line-by-line vs **capability specs**, not vs a narrowed task reading.

### 7. Leftover sweep (before final review)

Forge's implementers and reviewers stay inside `tasks.md` and the session
diff. That is why leftover consumers, docs, and files nobody listed survive a
green verify. This step catches them. **It runs before final review.**

#### Specs (`planType: specs`) — always on

Follow [../skills/specs-verify-change/SKILL.md](../skills/specs-verify-change/SKILL.md).
You (the coordinator) run this — not the final reviewer. Search the tree,
including files `tasks.md` never named. Fix **every** finding: CRITICAL,
WARNING, **and SUGGESTION**. Skip only an explicit no-action or a recorded
design decision. Save the report plus this block to
`.forge/sessions/<id>/spec-verify.md`:

```markdown
## Forge disposition

- Fixed: <what you changed, or none>
- Skipped: <finding> — <design-decision / explicit no-action reason>
- Remaining: none
```

Do not run the vendor OpenSpec sweep on a specs session, even if that skill
is on disk. Specs leftover is `spec-verify.md` only.

#### OpenSpec (`planType: openspec`) — when the vendor skill is present

Available means the vendor skill or slash command exists in the project
(`.cursor/skills/openspec-verify-change/`, `/opsx:verify`, …) **and** this
session's `planType` is `openspec`. If the skill is missing, skip it — do not invent a parallel sweep. Do not ask an OpenSpec session for
`spec-verify.md`.

1. Follow the vendor `openspec-verify-change` skill (or `/opsx:verify`) for
   the session's change. You (the coordinator) run this — not the final
   reviewer, who is forbidden from directory sweeps. Search the tree,
   including files `tasks.md` never named.
2. Fix **every** finding: CRITICAL, WARNING, **and SUGGESTION**. Leftover
   local copies, stale imports, missed files, and docs examples count.
   Dispatch a fix subagent for anything non-trivial.
3. Skip a finding only when it explicitly says no action, or it matches a
   recorded design decision that fixing would contradict. Record those under
   **Skipped** with the reason. Do not skip "nice to have" leftovers.
4. If you edited code after `verify-evidence.md` was recorded, re-run tier 3
   (see below). Then re-run OpenSpec verify. Cap at two extra passes (three
   total). Still dirty → stop and ask the user; do not loop.
5. Save the vendor report plus this block to
   `.forge/sessions/<id>/openspec-verify.md`:

```markdown
## Forge disposition

- Fixed: <what you changed, or none>
- Skipped: <finding> — <design-decision / explicit no-action reason>
- Remaining: none
```

`forge phase review` and `forge phase done` refuse while the engine's report
is missing or lacks a `Remaining: none` line. The vendor's "ready for archive
(with noted improvements)" is **not** enough — that is how SUGGESTION
leftovers used to ship.

```bash
forge phase verify
```

## When to re-run tier 3

- Tier 3 failed (fix, then re-run tier 3)
- Coordinator edited code after `verify-evidence.md` was recorded
- Quality or final reviewer flagged test gaps
- User explicitly asks for a fresh run

## When NOT to re-run

- Tier 2 narrow commands — already audited; duplicating them is slow and redundant
- Tier 3 passed and nothing changed since — do not run full suite again "for freshness"

Then proceed to [review.md](./review.md). Leftover findings must already be
fixed — the final reviewer reads the **post-fix** diff.
