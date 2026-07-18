# Finish phase

## OpenSpec path (`planType: openspec`)

1. Confirm all tasks complete in `tasks.md`.
2. User runs or approves `/opsx:archive` / `openspec archive`.
3. **ADR follow-up (optional):** if `.forge/config.json` has `adr.enabled: true`
   (or the project uses ADRs), follow the **`archive-to-adr`** skill using
   `adr.dir` / `adr.decisionsDoc`. If ADRs are disabled, skip.
4. End with **Suggested commit** block (display only — do not commit).

```bash
forge phase done
forge cleanup
```

## Specs path (`planType: specs`)

1. Confirm all tasks complete in `<specsDir>/changes/<name>/tasks.md`.
2. **Archive** (with user approval) — prefer the CLI:

   ```bash
   forge change archive <name>
   # → <specsDir>/changes/archive/YYYY-MM-DD-<name>
   ```

   Or move manually:

   ```bash
   git mv <specsDir>/changes/<name> <specsDir>/changes/archive/<YYYY-MM-DD>-<name>
   ```

   (plain `mv` if the dir is untracked).
3. **ADR follow-up (optional):** same rule as OpenSpec — if `adr.enabled`,
   follow **`archive-to-adr`** on the archived change; otherwise skip.
4. End with **Suggested commit** block (display only — do not commit).

```bash
forge phase done
forge cleanup
```

## Throwaway path (`planType: throwaway`)

1. Confirm all tasks in `plan.md` checked off.
2. Summarize what shipped.
3. Mark session done and cleanup:

```bash
forge phase done
forge cleanup
```

## Direct path (`planType: direct`)

1. Confirm implementation matches brainstorm `notes.md` / `decisions.md`.
2. Summarize what shipped.
3. Mark session done and cleanup:

```bash
forge phase done
forge cleanup
```

## Skipped path (`/forge:skip`)

Session already at `phase: skipped`. No finish steps.

## Hand-off

Leave implementation files staged/unstaged per user preference. Never commit unless
explicitly asked (project git policy).
