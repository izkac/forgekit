# Tiered test strategy (Forge)

Forge uses **three tiers**. Do **not** run the full workspace or monorepo test suite on every subagent task — that is slow and redundant when verify runs tier 3 once.

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

## Tier 3 — Verify phase (coordinator, after all tasks)

After all implement tasks complete:

1. **Audit** every `tasks/<nn>-<slug>/test-evidence.md` (exit `0`, pass summary, reviewers approved).
2. Run **one fresh full workspace test** for each affected workspace (plus downstream consumer workspaces when contracts changed).
3. Save output to `.forge/sessions/<id>/verify-evidence.md`.

Tier 3 is the integration/regression gate. Cite this file when claiming the implementation passes.

Re-run tier 3 when: tier 3 failed, coordinator edited code after verify evidence, quality/final review flagged test gaps, or the user asks for a fresh run.

**Do not** re-run tier 2 narrow commands at verify — audit them instead.

## Quick reference

| Tier | Who | When | Scope |
| ---- | --- | ---- | ----- |
| 1 | Implementer | Each TDD red/green/refactor | Single file or pattern |
| 2 | Implementer | Task done | Narrowest proof for this task |
| 3 | Coordinator | Verify phase (once) | Full affected workspace(s) |

## Anti-patterns

| Don't | Do instead |
| ----- | ---------- |
| Full workspace test on every task | Tier 1 scoped + tier 2 narrow evidence |
| Skip tier 3 because tasks passed | Always run tier 3 once at verify |
| Re-run tier 2 commands at verify | Audit task evidence; run tier 3 full suite |
| Full monorepo test at tier 2 | Tier 2 narrow; tier 3 per workspace (or listed consumers) |
