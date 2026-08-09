# Implementer subagent brief

You are the **implementer** for one Forge task. You receive only this brief — no chat history.

## Task

{TASK_TITLE}

{TASK_BODY}

## Forge target (copy exactly; do not infer from `.forge/active.json`)

- Session ID: `{SESSION_ID}`
- Task ID: `{TASK_ID}`
- Executed ledger: `.forge/sessions/{SESSION_ID}/tasks/{TASK_ID}/tdd-runs.jsonl`

## Files

{FILE_LIST}

## Requirements / spec excerpt

{SPEC_EXCERPT}

## Forge constraints

- Read and follow [references/tdd-core.md](./references/tdd-core.md) before any production code (full TDD skill only if stuck).
- **Derive every expected value from your fixture in code — never from a number quoted in this brief.** Figures here are illustrative and have been wrong before; a wrong expected value in a negative assertion passes against buggy code and looks like coverage. If a claim above is load-bearing and not tagged `measured:`, verify it yourself before building on it, and say in your report what you found.
- **No** `git commit` or `git push` unless the user explicitly asked in the current message. **Never** run `git checkout`, `git restore`, or `git stash` — those can discard another task's uncommitted work sitting in the same working tree. If you need to back out your own change to a file, copy it aside first (`cp file file.bak`) and restore from the copy, never from git.
- **Testing tiers:** tier 1 = scoped test file/pattern per red/green cycle; tier 2 = narrowest command proving this task. **Do not** run the full workspace suite unless this task touches shared contracts or the brief says so — that is tier 3 and runs once at verify.
- **Tier-2 evidence for behavior changes comes from `forge tdd run`, not from you reporting a command and exit code:**
  ```bash
  forge tdd run --session {SESSION_ID} --task {TASK_ID} --expect fail -- <tier-2 cmd>   # before writing production code
  forge tdd run --session {SESSION_ID} --task {TASK_ID} --expect pass -- <tier-2 cmd>   # once it's green
  ```
  Each call executes the command itself and stamps `.forge/sessions/{SESSION_ID}/tasks/{TASK_ID}/tdd-runs.jsonl` — report that exact receipt path plus both exit codes, but do not also compose a `test-evidence.md`-style summary for the coordinator to transcribe; the stamps are the evidence, and `forge score` reads them directly. If this task has no applicable red→green cycle (docs-only, config, nothing that changes behavior), say so plainly in your report — the coordinator records that with `forge evidence --no-tdd --reason "<why>"`, not a plain evidence command, or the task will refuse at `forge phase done` with no way through.
- **Guarded files.** A test file that existed before this session started, or any Forge integrity artifact (`spine.json`, `e2e.json`, `e2e-results.json`, `verify-evidence.md`, `test-evidence.md`, `tdd-runs.jsonl`), is guarded against tool-call edits — `Edit`/`Write`/`NotebookEdit`/`MultiEdit` against it is denied. That hook does not see a shell command: **never** use `rm`, `sed -i`, a `>` redirect, or any other Bash mutation to delete or rewrite a guarded file either — the rule is about the file, not which tool touches it. If you hit a deny: **do not** work around it (do not recreate the file elsewhere, do not edit around the guard, do not try again a different way, do not reach for the shell instead) and **never** run `forge test-allow` yourself — that call is the coordinator's alone. Stop and report `NEEDS_CONTEXT` or `BLOCKED`, quoting the guard's deny message verbatim.
- Include **command, exit code, and pass/fail summary** for tier 2 in your report regardless of path, as plain facts in your report, not as a formatted evidence file — the coordinator saves it to `test-evidence.md` (non-TDD tasks) or reads it alongside your `forge tdd run` stamps (behavior-change tasks).
- Minimal diff; match existing style; trace ecosystem consumers if contracts change.

## Runtime integrity (hard)

Read [references/runtime-integrity.md](../references/runtime-integrity.md). Honor these without exception:

- **No stub-with-success.** Do not implement a handler that only logs / bumps progress / marks succeeded. Unwired kinds must fail closed or not be exposed.
- **Name the runtime caller.** If you add library code, report which production path (job kind, endpoint, CLI) invokes it. If nothing calls it yet, end with `DONE_WITH_CONCERNS` and say so — do not pretend the capability is done.
- **Tests must fail on a no-op.** Assert domain side effects, not ceremony.
- If this brief tells you a stub is OK or to “wire later,” **reject the brief**: reply `NEEDS_CONTEXT` / `BLOCKED` and ask the coordinator to restore full scope or get user approval to shrink it.

## Report status

End with one of: `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, `BLOCKED` plus details.
