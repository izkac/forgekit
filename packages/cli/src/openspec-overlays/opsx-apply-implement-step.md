**REQUIRED (Forge):** Wrap this loop in the implement phase —
`{{PHASES_IMPLEMENT}}`.
Use bundled `skills/subagent-driven-development` + `skills/test-driven-development`.
Prefer **`/forge:apply`** over bare `/opsx:apply` — same OpenSpec CLI steps plus verify and review.

   Per pending `##` group in tasks.md (not per checkbox):
   - Show which group is being worked on
   - Dispatch one **implementer** for the group (tasks in order). Split 1:1 only when that task's own line is money/auth/contracts/migrations/secrets
   - At group close: one **task reviewer**. Mid-group low-risk: coordinator self-check. Immediate review only for the high-risk task line — not because the change name matched
   - Keep changes minimal and focused
   - Mark each task complete in the tasks file: `- [ ]` → `- [x]` (Forge fleet/status derive progress from these checkboxes)
   - Continue to the next group
