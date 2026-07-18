**REQUIRED (Forge):** Wrap this loop in the implement phase —
`{{PHASES_IMPLEMENT}}`.
Use bundled `skills/subagent-driven-development` + `skills/test-driven-development` per task.
Prefer **`/forge:apply`** over bare `/opsx:apply` — same OpenSpec CLI steps plus verify and review.

   For each pending task:
   - Show which task is being worked on
   - Dispatch **implementer** subagent (TDD first), then **spec** + **quality** reviewers
   - Keep changes minimal and focused
   - Mark task complete in the tasks file: `- [ ]` → `- [x]`
   - Continue to next task
