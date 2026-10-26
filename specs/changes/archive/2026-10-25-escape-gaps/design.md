# Design — escape-gaps

## Context
`nestedBaseCommits` is recorded at `forge new`; at done only the root `commitRange` is stored, and
`escapeCandidates` blames only the root repo. Confirming needs a replay test that nothing runs.

## Decisions
- **Ranges per repo from what `forge new` already recorded.** At done:
  `nestedCommitRanges: { "<repo>": { base, head } }`, omitting base == head and skipping a repo
  that is gone (noted). Alternative: rescan for repos at done (rejected: a repo created mid-session
  has no meaningful base).
- **Per-repo search reuses `escapeCandidates`.** The existing blame logic runs with `cwd` = the
  nested repo and its range; candidates carry `repo`. No change to the 14-day window or the
  candidate definition.
- **Time-window inference for history.** For a done session with no nested ranges, each nested repo
  present now gets a range from the commits in `[startedAt, endedAt]` (`git log --all`); a commit in
  several windows goes to the shortest containing session. Marked `inferred: "time-window"`;
  reported separately. Alternative: none (leaves Volo invisible).
- **Replay rules are recorded, not detected (ADR-0001).** `escapes.replay`: ordered
  `[{ match, cwd, command }]`; `match` is a glob over the project-root-relative test path;
  `command` contains `{file}` (the test path relative to `cwd`). First match wins.
- **Two runs in throwaway worktrees.** `git worktree add --detach <tmp> <fix^>` with the fix's test
  file copied in (old), and `<tmp> <fix>` (fix). `node_modules` at the rule's `cwd` is linked when it
  exists. `git worktree prune` first; links then worktrees removed in `finally`. Timeout per run
  (`escapes.replayTimeoutSec`, default 300). Spawned without a shell (argv split of `command`),
  like `forge evidence`.
- **Classification never dismisses.** old≠0 ∧ fix=0 → auto-confirmed (escape ledger entry,
  `auto: true`, command, exit codes, replay test). old output matching a module-resolution /
  syntax signature (one named constant) → `environment`; fix≠0 → `environment`; old=0 →
  `not-reproduced`; no rule / no test / timeout → undecided with reason. Tags live on the candidate
  in the escapes ledger, separate from decisions.
- **Version and models in the digest.** `forgekitVersion` from the CLI package; models from parent
  vs sidecar transcripts in `collectMetrics` (`null` when not separable).

## Risks
- A fix's test that needs fix-commit helpers can fail on old code for the wrong reason → the
  signature heuristic tags it `environment`; any auto-confirm stays overridable by `dismiss`.
- Linking `node_modules` from the current working copy may not match the old commit's dependency
  versions → a mismatch shows up as `environment` (fix run fails) rather than a false confirm.
- Running project tests is code execution → explicit command + exec opt-in, never automatic.
