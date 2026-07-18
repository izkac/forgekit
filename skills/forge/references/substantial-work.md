# Substantial work triage

Run this check **before** implementation on every agent turn unless the user
sent **`/forge:skip`**.

**Forge = OpenSpec.** If work is substantial enough for Forge, it is substantial enough for a
tracked OpenSpec change. Smaller work skips Forge entirely (direct execution).

## Enter Forge when ANY apply

- New feature or behavior change
- Bug fix that changes logic (not typo-only)
- Multi-file or multi-workspace edit
- Public API, Zod schema, OpenAPI, shared package export, or config schema change
- Cross-package / cross-product impact (grep consumers)
- User invokes `/forge` or any `/forge:*` command (except `/forge:skip`)
- Work would likely produce an ADR or new `openspec/specs/` capability

## Skip Forge (execute directly) when ALL apply

- Pure question, explanation, or read-only review
- Typo, comment, formatting-only, or rename with zero behavior change
- User explicitly sent **`/forge:skip`** for this task

## `/forge:skip` behaviour

1. If an active Forge session exists, run:
   ```bash
   forge phase skipped
   ```
2. Do **not** start brainstorm or plan for this task.
3. Proceed with the user's request under normal project rules.

## Ambiguous cases

Ask one clarifying question: **would this produce an OpenSpec change?** If yes → Forge (OpenSpec).
If no → execute directly. Skip requires explicit user opt-out (`/forge:skip`).
