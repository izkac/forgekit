# Tiered test strategy (Forge)

Forge uses **three tiers**, plus a **group tier** at each `tasks.md` group close. Do **not** run the full workspace or monorepo test suite on every subagent task — that is slow and redundant when verify runs tier 3 once.

## Tier 1 — TDD loop (within a task)

During red/green/refactor, run **scoped** commands only:

```bash
npm test -- path/to/scoped.test.ts -- path/to/changed.test.ts
```

- Single test file or pattern for the behavior under change
- Mandatory for TDD integrity (watch fail → pass)
- Fast; repeat as often as needed

## Tier 2 — Task completion evidence

Before marking a task complete, run the **narrowest** command that proves **this task's** changes work:

- Changed test file(s) + directly related tests in the same module/directory
- Subpath or pattern filter when the runner supports it
- **Not** the full workspace suite by default

Record in `.forge/sessions/<id>/tasks/<nn>-<slug>/test-evidence.md`. See [test-evidence.md](./test-evidence.md).

### Tier 2 may be wider (still not full monorepo)

- Shared contract or public API change → include contract tests in affected packages
- Cross-module integration within one workspace → run the relevant integration test directory
- Task brief explicitly requires full workspace coverage

### Do not use full workspace at tier 2 when

- Changes are localized (typical 1–3 file task)
- Multiple tasks target the same workspace (full suite runs once at **verify**)
- Motivation is only "to be safe" — that is **verify's** job

## Group tier — group close (coordinator)

At each `tasks.md` group close, run the tests **related to the group's diff**, not the full suite:

- Jest: `--changedSince=<base>`; Vitest: `run --changed <base>`
- `<base>` is `session.baseCommit` for the outer repo, or `session.nestedBaseCommits[<repo>]` for a nested git repo (or the last checkpoint sha when checkpoints are on). No `baseCommit` (project root is not a git repo) → name the changed test files explicitly instead
- Nested repo: run `forge` from the project root (it finds the session there) and change directory inside the command, e.g. `forge evidence --tier3 --scope group -- npm --prefix volo_web test -- --changedSince=<sha>`
- Stamp it: `forge evidence --tier3 --scope group -- <cmd>` (a group stamp never changes the `proven.tier3` verdict)

If the group's diff touches test harness, setup files, runner config, package manifests or lockfiles, **do not** run the full suite here. Note it in `group-review.md`; verify's single full run covers it.

**Runner blind spots.** Related-test selection only follows imports, so some tests are invisible to it (locale/translation files Vitest can't trace, name-registered model lists Jest can't see). Add those test paths explicitly. Projects list their blind spots in their `AGENTS.md`.

## Tier 3 — Verify phase (coordinator, after all tasks)

After all implement tasks complete:

1. **Audit** every `tasks/<nn>-<slug>/test-evidence.md` (exit `0`, pass summary, reviewers approved).
2. Run the leftover sweep (spec-verify / openspec-verify) and apply its fixes **before** the full run, so the full run covers them.
3. Run each affected workspace's full suite **exactly once**, one workspace after another (not in parallel), via `forge evidence --tier3 -- <cmd>` (plus downstream consumer workspaces when contracts changed).
4. Save output to `.forge/sessions/<id>/verify-evidence.md`.

Tier 3 is the integration/regression gate. Cite this file when claiming the implementation passes.

**No second full run.** Later failures and fixes are re-proven with scoped runs (`forge evidence --tier3 --scope <failed-only|fix> -- <cmd>`):

- **Red full run:** re-run only the failing files with `--scope failed-only`. Green alone means the failures were load-induced and tier 3 counts as passed (`forge status` says "via failed-only"). Still red is a real failure: `forge refute add … --source tier3`, fix, then re-run those files with `--scope failed-only`.
- **Sweep or review fixes:** run only the tests for what the fix touched, with `--scope fix`.
- **The one exception:** a fix that touches test harness, setup, runner config, package manifests or lockfiles earns one more `full` run.

Full runs take a cross-session lock, so a second session's full run waits instead of competing for the machine. Scoped runs never wait.

`forge evidence` also takes every configured lease (`.forge/config.json → leases`) whose `match` pattern hits its command — in lease-name order, before `tier3` (full-scope runs only) — and releases them when the command exits. If one is still busy after its `waitMs`, the run exits **75** with nothing run and nothing stamped; retry later, don't treat it as a test failure.

**Do not** re-run tier 2 narrow commands at verify — audit them instead.

## Quick reference

| Tier | Who | When | Scope |
| ---- | --- | ---- | ----- |
| 1 | Implementer | Each TDD red/green/refactor | Single file or pattern |
| 2 | Implementer | Task done | Narrowest proof for this task |
| Group | Coordinator | Each `tasks.md` group close | Tests related to the group's diff (`--scope group`) |
| 3 | Coordinator | Verify phase, after the sweep (once per workspace) | Full affected workspace(s) |
| 3 re-proof | Coordinator | Red full run, or sweep/review fixes | Failing files (`failed-only`) or touched tests (`fix`) |

## Anti-patterns

| Don't | Do instead |
| ----- | ---------- |
| Full workspace test on every task | Tier 1 scoped + tier 2 narrow evidence |
| Skip tier 3 because tasks passed | Always run tier 3 once at verify |
| Second full run after a red run or a late fix | `--scope failed-only` / `--scope fix` |
| Full suite at group close | Group tier: tests related to the diff |
| Re-run tier 2 commands at verify | Audit task evidence; run tier 3 full suite |
| Full monorepo test at tier 2 | Tier 2 narrow; tier 3 per workspace (or listed consumers) |
