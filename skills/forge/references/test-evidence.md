# Per-task test evidence (tier 2)

Each implement task records **tier 2** proof that subagents ran tests. See [test-strategy.md](./test-strategy.md) for all three tiers.

For behaviour tasks the evidence is the implementer's executed `forge tdd run` stamps (`tdd-runs.jsonl`); this file covers the rest. The **coordinator** records it — **executed**: `forge evidence --task <nn>-<slug> [--no-tdd --reason "…"] -- <cmd> [args…]` runs the command itself and captures the exit code and output tail (refuses non-zero exit without `--allow-fail`). The transcribed form `--command "<cmd>" --exit <code> --summary "<text>"` still works but warns, and the file says `UNVERIFIED` in its `Recorded by:` line — the exit code was the caller's word. Never hand-write the file. Verify **audits** these files — it does **not** re-run the same tier 2 commands. Verify runs **tier 3** (full workspace) once separately; see [../phases/verify.md](../phases/verify.md).

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
- **Recorded by:** forge evidence (executed — exit code and output captured from the process)

```text
<last ~20 lines of output>
```
```

## Rules

- **Exit code must be `0`** before the task is marked complete.
- **Default:** narrowest command — changed test file(s) + directly related tests. **Not** the full workspace suite.
- **Full workspace at tier 2** only when the task changes shared contracts, cross-module integration, or the brief explicitly requires it. Note `Tier: 2 (full workspace — contract/integration)` in the file.
- If the implementer re-ran tests after a fix, overwrite with the latest successful tier 2 run.
- Verify **audits** tier 2 files and runs **tier 3** (full workspace) once — see [test-strategy.md](./test-strategy.md).
