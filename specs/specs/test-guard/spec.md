# Test Guard Spec

## Purpose

Describe this capability.

## Requirements

### Requirement: Guarded-file classifier
The system SHALL classify a repo-relative path as guarded when it either
matches the project's test globs (`.forge/config.json → guard.testGlobs`,
defaulting to `**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`, `**/test/**`,
`**/tests/**`) **and** was tracked at the session's `baseCommit`, is a forge
integrity artifact (`spine.json`, `e2e.json`, `e2e-results.json`,
`verify-evidence.md`, `openspec-verify.md`, `test-evidence.md`, `tdd-runs.jsonl`) regardless of
tracking state, or is one of Forge's own control-surface files under
`.forge/` (`config.json`, `active.json`, any session's `session.json`)
regardless of tracking state or the current `guard.testGlobs` value. One
classifier module SHALL serve both the hook path and the integrity backstop.

An override resolving to zero usable glob strings (`[]`, or an array of only
empty/whitespace strings) is a configuration error, not an instruction to
guard nothing: the classifier SHALL fall back to the default globs and
surface a warning, so silencing the guard for every test file requires an
explicit, reviewable override rather than an empty list.

#### Scenario: Baseline test file is guarded

- GIVEN a session with `baseCommit` at which `packages/cli/src/foo.test.mjs` is tracked
- WHEN the classifier evaluates that path
- THEN it is guarded

#### Scenario: Test file created during the session is not guarded

- GIVEN a test-glob-matching path not tracked at `baseCommit`
- WHEN the classifier evaluates it
- THEN it is not guarded

#### Scenario: Integrity artifact is guarded regardless of age

- GIVEN a path ending in `spine.json` created during the session
- WHEN the classifier evaluates it
- THEN it is guarded

#### Scenario: Project globs override defaults

- GIVEN `.forge/config.json` sets `guard.testGlobs` to `["spec/**"]`
- WHEN the classifier evaluates `packages/cli/src/foo.test.mjs`
- THEN it is not guarded

#### Scenario: An empty testGlobs override does not disable the guard

- GIVEN `.forge/config.json` sets `guard.testGlobs` to `[]`
- WHEN the classifier evaluates a path tracked at `baseCommit` and matching a default glob
- THEN it is guarded, and the classifier reports a warning naming the invalid override

#### Scenario: Forge's own config is guarded regardless of testGlobs

- GIVEN `.forge/config.json` sets `guard.testGlobs` to `["nothing/**"]`
- WHEN the classifier evaluates `.forge/config.json` itself
- THEN it is guarded

#### Scenario: A session's own session.json is guarded

- GIVEN any path `.forge/sessions/<id>/session.json`
- WHEN the classifier evaluates that path
- THEN it is guarded, regardless of tracking state

#### Scenario: The active-session pointer is guarded

- GIVEN the path `.forge/active.json`
- WHEN the classifier evaluates that path
- THEN it is guarded, regardless of tracking state

#### Scenario: A same-named file outside .forge/ is not swept up

- GIVEN a path `some/other/project/config.json` not under `.forge/`
- WHEN the classifier evaluates that path
- THEN the control-surface rule does not apply (ordinary classification still applies)

### Requirement: PreToolUse hook denies guarded edits during the enforcement window
The `forge-test-guard.mjs` PreToolUse hook SHALL, for Edit, Write, and
NotebookEdit tool calls, deny the call when `forge guard check` classifies
the target as guarded without an allowance and the session phase is
implement, verify, review, or finish. The hook SHALL allow (with a stderr
warning) on any internal error, and SHALL fast-allow when there is no active
session, the phase is pre-implement or terminal, the file is unguarded, or an
allowance is recorded.

Resolution of which session governs an invocation with no explicit
`--session` SHALL NOT depend solely on the mutable `.forge/active.json`
pointer: the hook SHALL deny when **any** unfinished session whose phase is
in the enforcement window classifies the target as guarded (without an
allowance recorded in that session's own ledger), even when `active.json`
names a different, non-guarding session. An explicit `--session <id>`
evaluates only that session (no cross-session consideration).

Some guarded classes freeze later than the general implement→finish window:
`verify-evidence.md` and `openspec-verify.md` (authored during the verify phase
itself, per verify.md) are unrestricted through implement and verify, and freeze
from review onward. All other guarded classes (test files, `spine.json`,
`e2e.json`, `e2e-results.json`, `test-evidence.md`, `tdd-runs.jsonl`, and
Forge's own control-surface files) keep the implement-onward window.

#### Scenario: Edit to a baseline test is denied during implement

- GIVEN an active session in phase implement
- AND a guarded baseline test file with no allowance
- WHEN a Write tool call targets that file
- THEN the hook denies the call
- AND the message names the matched rule and the `forge test-allow` escape

#### Scenario: Guard stays active during verify

- GIVEN the same session moved to phase verify
- WHEN an Edit tool call targets the guarded file
- THEN the hook denies the call

#### Scenario: Broken guard fails open

- GIVEN `forge guard check` exits 1 (internal error)
- WHEN a Write tool call targets any file
- THEN the hook allows the call
- AND prints a warning to stderr

#### Scenario: Pre-implement phases are unrestricted

- GIVEN an active session in phase plan
- WHEN a Write tool call targets a guarded file
- THEN the hook allows the call

#### Scenario: A second, out-of-window session does not shadow the guarding session

- GIVEN session A in phase implement whose baseline guards a file
- AND session B in phase triage, with `.forge/active.json` naming session B
- WHEN a Write tool call targets that file with no explicit `--session`
- THEN the hook denies the call, naming session A

#### Scenario: An explicit --session evaluates only the named session

- GIVEN session A in phase implement whose baseline guards a file
- AND session B in phase plan (unrestricted) named explicitly via `--session`
- WHEN `forge guard check --session <B> --file <file>` runs
- THEN the check allows, reflecting only session B's phase

#### Scenario: verify-evidence.md is editable during its own authoring phase

- GIVEN an active session in phase verify
- WHEN a Write tool call targets that session's `verify-evidence.md`
- THEN the hook allows the call

#### Scenario: verify-evidence.md freezes from review onward

- GIVEN the same session moved to phase review
- WHEN a Write tool call targets `verify-evidence.md`
- THEN the hook denies the call

#### Scenario: openspec-verify.md is editable during its own authoring phase

- GIVEN an active session in phase verify
- WHEN a Write tool call targets that session's `openspec-verify.md`
- THEN the hook allows the call

#### Scenario: openspec-verify.md freezes from review onward

- GIVEN the same session moved to phase review
- WHEN a Write tool call targets `openspec-verify.md`
- THEN the hook denies the call

### Requirement: Allowances are recorded, reasoned, and surfaced
`forge test-allow <path> --reason "<text>"` SHALL append
`{path, reason, at, phase}` to `guard-allowances.json` in the session
directory, refusing an empty reason and refusing on ambiguous session
resolution (gate-class). Recorded allowances SHALL be honored by both the
hook and the integrity backstop, and SHALL be listed in reviewer packet
context and the scorecard.

#### Scenario: Allowance unlocks a guarded file

- GIVEN a guarded file denied by the hook
- WHEN the operator runs `forge test-allow <path> --reason "assertion outdated by REQ-4 change"`
- THEN a subsequent `forge guard check` on that path allows
- AND the allowance appears in the session ledger

#### Scenario: Missing reason is refused

- WHEN `forge test-allow <path>` runs without `--reason`
- THEN the command exits non-zero and records nothing

### Requirement: Integrity backstop refuses unaccounted guarded changes
`forge integrity-check` (and therefore `forge phase done|finish`) SHALL fail
when any guarded file is modified or deleted between the session's
`baseCommit` and the worktree without a matching allowance. When
`baseCommit` is unavailable the check SHALL degrade to a skip with a printed
warning, not a false pass or false fail.

This check reads `git diff`, which only ever reports **tracked** files —
`.forge/config.json` is ordinarily tracked and so is covered here; a
session's own `session.json` and `.forge/active.json` are not (they live
under the normally-gitignored `.forge/sessions/`), so a tamper to either is
invisible to this check regardless of what changed. The PreToolUse hook's
`forge-control:` denial is the sole real-time defense for those two files;
this backstop's coverage of them is not required and is not claimed.

#### Scenario: Tampered baseline test refuses done

- GIVEN a baseline test file modified during the session with no allowance
- WHEN the operator runs `forge phase done`
- THEN the transition is refused naming the file

#### Scenario: Allowance clears the backstop

- GIVEN the same modification with a recorded allowance for that path
- WHEN `forge integrity-check` runs
- THEN the guarded-files check passes

#### Scenario: Deleted test is caught on every host

- GIVEN a project where hooks are not wired (e.g. Codex host)
- AND a baseline test file deleted during the session
- WHEN `forge phase done` runs
- THEN the transition is refused

### Requirement: Path spelling does not bypass the guard on case-insensitive filesystems
On a filesystem where paths are case-insensitive — macOS/APFS and Windows —
the classifier SHALL treat a path that differs from a tracked path only in
case as the same file. `src/A.test.mjs` and `SRC/a.test.mjs` SHALL be guarded
when `src/a.test.mjs` is tracked at the session's `baseCommit`, because on
those filesystems all three spellings write the same inode.

On a case-sensitive filesystem the comparison SHALL remain exact:
`Foo.test.mjs` and `foo.test.mjs` are genuinely different files there, and
folding would guard a file that is not tracked.

The platform decision SHALL be injectable so that both behaviours are
testable on a single CI runner rather than only on the host's own filesystem.

This closes the **real-time hook layer only**. The integrity backstop already
catches the resulting content change at `forge phase done` regardless of how
the path was spelled, so this restores one layer of two rather than closing a
total bypass.

#### Scenario: A case-variant filename is guarded on a folding platform

- GIVEN `src/a.test.mjs` tracked at the session's baseCommit
- AND a platform whose filesystem is case-insensitive
- WHEN the classifier evaluates `src/A.test.mjs`
- THEN it is guarded

#### Scenario: A case-variant directory is guarded on a folding platform

- GIVEN the same tracked file and platform
- WHEN the classifier evaluates `SRC/a.test.mjs`
- THEN it is guarded

#### Scenario: Case is significant on a case-sensitive platform

- GIVEN the same tracked file
- AND a platform whose filesystem is case-sensitive
- WHEN the classifier evaluates `src/A.test.mjs`
- THEN it is not guarded

#### Scenario: An unrelated file is unaffected on either platform

- GIVEN the same tracked file
- WHEN the classifier evaluates `src/other.mjs` on either platform
- THEN it is not guarded

#### Scenario: An allowance follows case variants only on a folding platform

- GIVEN an allowance recorded for `src/a.test.mjs`
- WHEN the guard evaluates `src/a.TEST.mjs` on a case-insensitive platform
- THEN the allowance applies
- AND the same variant does not inherit the allowance on a case-sensitive platform
