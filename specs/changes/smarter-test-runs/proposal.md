# Smarter test runs

## Why
Forge sessions on a real project ran the full test suite 3–7 times per change,
each run 30–57 minutes under load. The docs require a fresh full run after any
code edit that follows verify evidence, and the leftover sweep runs *after* the
full run, so its fixes almost always trigger a second one. Several sessions on
the same project (often in separate worktrees) also start full suites at the
same time; the resulting machine load produces failures (251 and 62 in two
runs) that are not real, which then cause yet another full run.

## What Changes
- `forge evidence --tier3` takes a cross-session lock for full runs, keyed on
  the git common dir so worktrees of one repo share it. A busy lock waits and
  names the holder; a dead holder is taken over; a lock that cannot be created
  is skipped with a warning.
- Tier-3 stamps carry a `scope`: `full` (default), `failed-only`, `fix`,
  `group`. `forge status` judges tier 3 by the last `full` run; a red full run
  is rescued only by a later green `failed-only` run.
- New group-level test step: diff-related tests at each task-group close,
  stamped `--scope group`, never a full run.
- Verify runs the leftover sweep before tier 3, runs each affected workspace's
  full suite once, re-runs only failing files after a red full run, and runs
  only fix-scoped tests after sweep/review fixes.
- `forge new` records base commits for nested git repos
  (`session.nestedBaseCommits`; the outer repo already has `baseCommit`) so
  `--changedSince` has a base in every repo.
- Integrity-seal refresh writes atomically and retries transient file errors,
  removing a false tamper failure seen under load.

## Capabilities
- `test-runs`: new — lock, stamp scope, tier-3 verdict, run-count rules
- `session-lifecycle`: nested-repo base commits recorded at session start
- `test-guard`: seal refresh survives transient file errors

## Impact
- Code: `packages/cli/src/tier3-lock.mjs` (new), `record-evidence.mjs`,
  `proven.mjs`, `new-session.mjs`, `integrity-seal.mjs`, `plan-progress.mjs`,
  `score.mjs`, `scripts/e2e/harness-portability.mjs` (`tier3-lock` step).
- Docs/skills: `references/test-strategy.md`, `phases/verify.md`,
  `phases/close.md`, `phases/implement.md` (group step),
  `skills/verification-before-completion`, `skills/specs-verify-change`,
  `subagents/closer-prompt.md`, `docs/forge.md`, CHANGELOG.
- Back-compat: `--tier3` without `--scope` means `full`; stamps without a
  `scope` field read as `full`.
- Risk: a stale lock blocking forever if pid-liveness misreports (PID reuse).
  Mitigated by holder message naming pid/session so the operator can delete it.
