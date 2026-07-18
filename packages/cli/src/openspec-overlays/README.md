# OpenSpec Forge overlays

Vendor OpenSpec skills and `/opsx:*` commands are upgraded in place. **Do not hand-edit** them.

Forge adaptations live here and are applied by:

```bash
forge overlay
```

Run after refreshing OpenSpec skills/commands from upstream (usually via `forge init --overlay`).

| Overlay | Targets |
| ------- | ------- |
| `opsx-apply-implement-step.md` | Step 6 in `opsx-apply` / `opsx/apply` commands |
| `opsx-apply-completion-step.md` | Step 7 “all done” bullet in same commands |
| `openspec-apply-change-footer.md` | Footer on `openspec-apply-change/SKILL.md` (all agents) |

**Forge-owned (never overwritten):** `/forge:apply` command, `forge/` skill tree.
