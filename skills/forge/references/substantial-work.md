# Substantial work triage

Run this check **as Step 0 after the user invoked Forge** — `/forge` /
`/forge:*` (except `/forge:skip`), or natural language “use Forge” /
“using Forge” / “use the Forge …”. Do **not** enter Forge on a plain
request, even if the work looks substantial.

**You decide** whether invoked work is substantial enough to continue the
pipeline. You can see the conversation, the repository and the session.

**Forge = a tracked change.** If work continues through Forge, it is
substantial enough for a tracked change (OpenSpec or the built-in specs
engine). Smaller work executes directly after this step.

## Enter / continue Forge when invoked AND ANY apply

- User invoked `/forge` or any `/forge:*` command (except `/forge:skip`)
- User asked to **use Forge** (or “using Forge” / “use the Forge …”)
- An active session already exists for this work (follow-ups may continue without a second invoke)

Then continue the pipeline when the work is a feature, logic-changing bug,
multi-file edit, public API/schema change, or would produce a tracked
capability. Honor `/forge` on small work by still running this step — you
may execute directly if it is truly trivial, and the plan-time exit ramp
still applies once the work is shaped.

## Skip the rest of the pipeline (execute directly) when ANY apply

- No invoke and no active session for this work
- Pure question, explanation, or read-only review
- Typo, comment, formatting-only, or rename with zero behavior change
- User explicitly sent **`/forge:skip`** for this task

## `/forge:skip` behaviour

1. If an active Forge session exists, run:
   ```bash
   forge phase skipped        # refuses if several sessions are open — add --session <id>
   ```
2. Do **not** start brainstorm or plan for this task.
3. Proceed with the user's request under normal project rules.

## Ambiguous cases (only after invoke)

Ask one clarifying question: **would this produce a tracked change?** If yes → continue Forge. If no → execute directly.
