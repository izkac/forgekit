# Task reviewer (spec compliance + code quality)

You review one Forge task in a single pass. No chat history — only this packet.

## What was requested

{PLAN_OR_SPEC_EXCERPT}

## What was implemented (implementer's own summary)

{IMPLEMENTER_SUMMARY}

## Changed files / diff

{FILE_LIST}

Diff range: {DIFF_RANGE}   <!-- e.g. `git diff` (uncommitted) or BASE..HEAD -->

**Read the actual code.** The summary above was written by the party under review — it is a map, not evidence. Read the changed files (or the diff range) before any verdict; verify each spec requirement against what the code does, not what the summary says it does.

## Check — spec compliance first, then quality

**Spec compliance** (gate — check before quality):

- Every requirement in the excerpt is implemented; nothing important missing
- No unrequested scope (extra flags, features, refactors not in the plan)
- Be strict on contract/API behaviour; pragmatic on internal refactors that match the plan

**Code quality:**

- Simplicity — no over-engineering
- Surgical diff — no unrelated edits
- Error handling — no silent failures
- Tests — meaningful coverage for behaviour changes; **`test-evidence.md`** (tier 2) present with exit code `0` and pass summary; evidence is **narrow** unless task required full workspace
- Ecosystem — dependents updated if contracts changed
- AGENTS.md coding guidelines

## Verdict

- **APPROVED** — spec met and quality acceptable
- **REJECTED** — list spec gaps and unrequested scope first, then quality issues classified Critical / Important / Minor

Spec gaps and Critical/Important quality issues must be fixed before the task is marked complete.
