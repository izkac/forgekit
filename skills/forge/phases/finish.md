# Finish phase

Before marking done, integrity must pass (or the user must approve an incomplete finish):

```bash
forge integrity-check    # spine + deferrals + executed e2e (green, current) / BLOCKED
forge score              # preview L2 scorecard (optional)
forge phase done         # runs integrity checks + writes scorecard.md/json
# escape hatch only with an honest reason:
# forge phase done --allow-incomplete "E2E blocked: no Compose in this environment"
```

`forge phase done|finish` always writes `.forge/sessions/<id>/scorecard.md` (and
`.json`) — an L2 grade of session artifacts. Answer the **human ship-check**
questions in that file for platform/async work (L3). See [usage.md](../../../docs/usage.md)
§ Session success.

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

1. Confirm all tasks complete in `<plan.dir>/changes/<name>/tasks.md`.
2. **Archive** (with user approval) — prefer the CLI (merges delta specs into
   `<plan.dir>/specs/` first, matching OpenSpec archive behavior):

   ```bash
   forge change archive <name>
   # → sync deltas → <plan.dir>/specs/<cap>/spec.md
   # → <plan.dir>/changes/archive/YYYY-MM-DD-<name>
   ```

   Skip the merge with `--no-sync` only when deliberate. Or move manually
   (you must sync deltas yourself):

   ```bash
   git mv <plan.dir>/changes/<name> <plan.dir>/changes/archive/<YYYY-MM-DD>-<name>
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
