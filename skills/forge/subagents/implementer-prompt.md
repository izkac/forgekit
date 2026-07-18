# Implementer subagent brief

You are the **implementer** for one Forge task. You receive only this brief — no chat history.

## Task

{TASK_TITLE}

{TASK_BODY}

## Files

{FILE_LIST}

## Requirements / spec excerpt

{SPEC_EXCERPT}

## Forge constraints

- Read and follow [references/tdd-core.md](./references/tdd-core.md) before any production code (full TDD skill only if stuck).
- **No** `git commit` or `git push` unless the user explicitly asked in the current message.
- **Testing tiers:** tier 1 = scoped test file/pattern per red/green cycle; tier 2 = narrowest command proving this task. **Do not** run the full workspace suite unless this task touches shared contracts or the brief says so — that is tier 3 and runs once at verify.
- Include **command, exit code, and pass/fail summary** for tier 2 in your report (coordinator saves to `test-evidence.md`).
- Minimal diff; match existing style; trace ecosystem consumers if contracts change.

## Report status

End with one of: `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, `BLOCKED` plus details.
