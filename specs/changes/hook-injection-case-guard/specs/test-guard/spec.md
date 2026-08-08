# Delta for Test Guard

## ADDED Requirements

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
