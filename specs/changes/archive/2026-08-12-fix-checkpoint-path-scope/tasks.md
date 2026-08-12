# Tasks

## 1. Enumerate other open sessions + classify pending entries (pure lib)

- [x] 1.1 Red test in `packages/cli/src/checkpoint.test.mjs`: a pure function
      that, given the sessions dir, this session's id, and the plan dir, returns
      the change-directory paths of other unfinished sessions (phase not `done`
      / `skipped`, id ≠ this, change dir exists on disk). Assert it skips done,
      skipped, this session, and malformed/unreadable session files. Verify: the
      test fails first.
- [x] 1.2 Implement `otherOpenChangeDirs(...)` in
      `packages/cli/src/checkpoint.mjs` (exported, pure). Reads
      `.forge/sessions/*/session.json`; a malformed/unreadable file is skipped,
      not fatal. Verify: 1.1 passes.
- [x] 1.3 Red test: a pure classifier that partitions pending entries into
      `mine` (under this session's change dir), `foreignPlan` (under one of the
      other-open change dirs), and `shared` (everything else), using
      segment-aware prefix matching (`src/foo` ≠ `src/foobar`). Reuse or factor
      the prefix helper the existing `foreignUntrackedChangePaths` uses — do not
      re-implement matching subtly differently. Verify: fails first.
- [x] 1.4 Implement the classifier (exported, pure). Verify:
      `node --test packages/cli/src/checkpoint.test.mjs`.

## 2. The refusal gate + `--path` scoping (wire into the command)

- [x] 2.1 Red test: with another open session present and a `shared` (or
      `foreignPlan`) pending entry, `forge checkpoint` (no `--path`) exits
      non-zero without committing, and the message names the offending path and
      tags any `foreignPlan` path with its owning session. Drive the shipped
      binary or the command body; assert no commit was created (HEAD unchanged).
      Verify: fails first.
- [x] 2.2 Add the gate to `checkpoint.mjs`: when `otherOpenChangeDirs` is
      non-empty and no `--path`, refuse if any `foreignPlan` or `shared` entry
      exists; proceed (stage `mine`) when only `mine` is pending. Keep the
      single-session path (`git add -A` + existing untracked backstop) unchanged
      when there is no other open session. Verify: 2.1 passes.
- [x] 2.3 Red test: `forge checkpoint --path <mine-file>` on the two-session tree
      stages that file and the session's own change dir but NOT a shared file;
      and `--path <other session's change dir>` refuses. Verify: fails first.
- [x] 2.4 Parse `--path` (repeatable) in the flag loop, and implement scoped
      staging: stage `mine` + entries under each `--path`, via an explicit
      pathspec `git add` rather than `-A`; refuse a `--path` under a foreignPlan
      dir. Update the usage string. Verify:
      `node --test packages/cli/src/checkpoint.test.mjs`.
- [x] 2.5 Regression test: a single open session still stages `git add -A`
      (excluding scratch) and commits, and the existing foreign-untracked-change-
      dir backstop still refuses. Verify:
      `node --test packages/cli/src/checkpoint.test.mjs`.

## 3. Product loop

- [x] 3.1 Add a `checkpoint-scope` case to
      `scripts/e2e/harness-portability.mjs` (reuse it — do not build a new
      harness). On a throwaway git project with checkpoints enabled and two
      unfinished sessions: a shared tracked edit belonging to session B is
      present; assert `forge checkpoint` for session A refuses and does not
      commit it; then `forge checkpoint --path <A's file>` commits A's file and
      leaves B's edit unstaged. Add it to `ALL_ROSTER` and the usage string.
      Print `CHECKPOINT SCOPE GREEN`. Verify:
      `node scripts/e2e/harness-portability.mjs checkpoint-scope`.
- [x] 3.2 Run the full product loop green and current. Verify: `forge e2e run`
      exits 0 with all steps passing.
