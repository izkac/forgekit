# Hook injection and case-insensitive guard bypass

## Why

Two verified defects in shipped code, both found while dogfooding the
`tdd-evidence-guard` change and both left open when it merged.

**F79 — command injection on every prompt submission.**
`forge-prompt-hook.mjs` and `forge-triage-hook.mjs` spawn `forge` with
`shell: true` while passing the raw user prompt as an argv element. Node joins
argv into a shell command string without quoting, so the prompt's content
reaches a shell. Reproduced: a prompt of `hello; touch /tmp/PWNED_F79 #`
created the file. The trigger is **ordinary prompt text** — a backtick or
semicolon in a pasted code snippet is enough; no attacker is required. This
fires on every `UserPromptSubmit` in a wired project.

This is the same class the `tdd-evidence-guard` change fixed in
`forge-test-guard.mjs` after review reproduced it there. The fix was applied
to the new hook and not to its two older siblings.

**F90 — the test guard's real-time layer is bypassable by path spelling.**
`classifyGuarded` matches `git ls-tree` output exactly, so `src/A.test.mjs`
and `SRC/a.test.mjs` are classified unguarded where `src/a.test.mjs` is
denied. Reproduced on `main`. On macOS/APFS and Windows — the two most common
Claude Code hosts — those spellings write the guarded file's inode, so an
agent can edit a protected test by changing its capitalisation.

## What Changes

- Both prompt hooks spawn without a shell except on win32, where `forge` is a
  `.cmd` shim and a shell is required; quoting is confined to that branch.
  Their `.claude/hooks/` copies stay byte-identical.
- `makeGitLsTree` folds case in its tracked-path lookup on `darwin` and
  `win32` only. Linux stays exact, because on a case-sensitive filesystem
  `Foo.test.mjs` and `foo.test.mjs` are genuinely different files and folding
  would guard one that is not tracked.

## Capabilities

- `test-guard`: case-insensitive path spelling no longer bypasses the guard —
  delta at `specs/test-guard/spec.md`
- `project-wiring`: hooks pass untrusted text to `forge` without a shell —
  delta at `specs/project-wiring/spec.md`

## Impact

- Modified: `templates/project/claude/hooks/forge-prompt-hook.mjs`,
  `forge-triage-hook.mjs` and their `.claude/hooks/` copies;
  `packages/cli/src/guard.mjs`; the corresponding test suites.
- **Not in scope, deliberately.** F88 was verified **already fixed** — the
  `RULE_GUARD_FROM_PHASE` window landed later in the same change, after the
  finding was filed, and `verify-evidence.md` now allows during `verify` and
  denies from `review`. The finding is resolved, not re-fixed. F96 (an EPIPE
  crash in `forge prefs`) reproduced twice during this session's own workflow
  but lives in an unrelated file and stays filed; folding it in would repeat
  the scope creep this change exists to correct.
- **Honest limit on F90.** This closes the real-time hook layer only. The
  integrity backstop already catches the content change at `done` regardless
  of path spelling, so the hole was one layer of two, and the fix restores
  that layer rather than closing a total bypass.
- Risk: case-folding is platform-conditional, so the behaviour under test
  differs from the behaviour on the CI matrix's Linux runners. Tests must
  drive the folding logic directly rather than relying on the host platform.
