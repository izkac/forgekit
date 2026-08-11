# Substantial work triage

**You decide** whether work is substantial enough for Forge — you can see the
conversation, the repository and the session; the prompt-time filter cannot.

The prompt-time filter (`forge triage --check`) does not make that call. Its
only job is to suppress the reminder — decide whether to ask you at all — for
prompts carrying no work content: empty, `/forge:skip`, a bare conversational
reply ("thanks", "continue"), a read-only question, or a stated trivial edit
(typo, formatting-only, comment-only, rename with zero behavior change,
docs-only). Everything else reaches you as a question to weigh, never a
verdict already reached.

**Forge = OpenSpec.** If work is substantial enough for Forge, it is
substantial enough for a tracked OpenSpec change. Smaller work skips Forge
entirely (direct execution).

## Enter Forge when ANY apply

- New feature or behavior change
- Bug fix that changes logic (not typo-only)
- Multi-file or multi-workspace edit
- Public API, Zod schema, OpenAPI, shared package export, or config schema change
- Cross-package / cross-product impact (grep consumers)
- User invokes `/forge` or any `/forge:*` command (except `/forge:skip`)
- Work would likely produce an ADR or new `openspec/specs/` capability

## Skip Forge (execute directly) when ANY apply

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

## Ambiguous cases

Ask one clarifying question: **would this produce an OpenSpec change?** If yes → Forge (OpenSpec). If no → execute directly.
