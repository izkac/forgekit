
---

<!-- forgekit:openspec-overlay:start -->

## Forge overlay (re-applied by `forge overlay`)

When this runs inside a **Forge session** (`forge status` shows an active
session with `planType: openspec`):

1. Save the vendor report to `.forge/sessions/<id>/openspec-verify.md`.
2. **Fix every finding** (CRITICAL, WARNING, SUGGESTION), including files
   `tasks.md` never listed. Skip only an explicit no-action / recorded design
   decision, and say so under **Skipped**.
3. End the file with a `Remaining: none` line. `forge phase review` refuses
   without it — then dispatch the final reviewer on the **post-fix** diff.
4. Prefer this as part of Forge verify (`phases/verify.md` §7), not as a
   substitute for `/forge:apply`'s tail.

<!-- forgekit:openspec-overlay:end -->
