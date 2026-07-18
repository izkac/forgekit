# Per-task test evidence (tier 2)

Each implement task records **tier 2** proof that subagents ran tests. See [test-strategy.md](./test-strategy.md) for all three tiers.

The **coordinator** records this file after the implementer reports — use `forge evidence --task <nn>-<slug> --command "<cmd>" --exit <code> --summary "<text>"` (machine timestamp; refuses non-zero exit without `--allow-fail`) rather than hand-writing it. Verify **audits** these files — it does **not** re-run the same tier 2 commands. Verify runs **tier 3** (full workspace) once separately; see [../phases/verify.md](../phases/verify.md).

## Path

`.forge/sessions/<session-id>/tasks/<nn>-<slug>/test-evidence.md`

## Template

```markdown
# Test evidence — Task {nn}-{slug}

- **Tier:** 2 (task-scoped — not full workspace unless noted)
- **Command:** `npm test -- path/to/scoped.test.ts -- src/foo.test.ts`
- **Exit code:** 0
- **Summary:** 3/3 pass (or paste last ~20 lines of output)
- **Run at:** 2026-06-05T15:04:22Z
- **Recorded by:** implementer subagent (coordinator transcript)
```

## Rules

- **Exit code must be `0`** before the task is marked complete.
- **Default:** narrowest command — changed test file(s) + directly related tests. **Not** the full workspace suite.
- **Full workspace at tier 2** only when the task changes shared contracts, cross-module integration, or the brief explicitly requires it. Note `Tier: 2 (full workspace — contract/integration)` in the file.
- If the implementer re-ran tests after a fix, overwrite with the latest successful tier 2 run.
- Verify **audits** tier 2 files and runs **tier 3** (full workspace) once — see [test-strategy.md](./test-strategy.md).
