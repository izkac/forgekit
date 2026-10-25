# Tasks

## 1. Commit ranges per repository
- [x] 1.1 `set-phase.mjs`: at `forge phase done` record `nestedCommitRanges` from `session.nestedBaseCommits` and each nested repo's HEAD; omit base == head; skip (and note) a missing repo; tests in a new test file with a temp repo holding a nested repo
- [x] 1.2 `escapes.mjs`: `escapeCandidates` searches the root range and each nested range (blame with `cwd` = that repo); candidates carry `repo`; `pendingCandidates` / `forge escapes list` show it; tests
- [x] 1.3 `escapes.mjs`: time-window inference for sessions without nested ranges (`git log --all` in `[startedAt, endedAt]`, shortest-session attribution, `inferred: "time-window"`); `forge escapes report` shows inferred candidates separately; tests

## 2. Replay verification
- [ ] 2.1 New `packages/cli/src/escapes-replay.mjs`: resolve the first matching `escapes.replay` rule; run a command in a throwaway worktree (prune first; old = fix^ with the fix's test file copied in; fix = fix commit; link `node_modules` at the rule's `cwd` when present; timeout `escapes.replayTimeoutSec`, default 300; no shell; links then worktrees removed in `finally`); tests in temp repos, including cleanup on failure and the operator's working tree untouched
- [ ] 2.2 Classification + ledger: auto-confirmed (old≠0 ∧ fix=0, ledger entry `auto: true` with command, exit codes, replay test), `environment` (module-resolution/syntax signature in old output — one named constant — or fix≠0), `not-reproduced` (old=0), undecided with reason (no rule / no test / timeout); tags stored on the candidate, never a dismissal; `dismiss` still overrides an auto-confirm; tests
- [ ] 2.3 `forge escapes verify [--all | <session> <commit>]` in `escapes-cli.mjs`, behind the exec opt-in (same gate as `forge evidence`); per-candidate output line + summary; tests that spawn the bin

## 3. Version and models
- [ ] 3.1 Digest gains `forgekitVersion` and `models: { coordinator, subagents }` (from parent vs sidecar transcripts in `metrics/collect.mjs`; `null` when not separable); tests
- [ ] 3.2 `forge escapes report --by version`; tests

## 4. Docs and product loop
- [ ] 4.1 `CONTEXT.md` **Commit range** per repository (+ inferred note); `docs/usage.md` and `skills/forge/docs/forge.md`: `escapes.replay`, `forge escapes verify`, `--by version`; CHANGELOG (docs-only, `--no-tdd`)
- [ ] 4.2 Product loop: `scripts/e2e/harness-portability.mjs` phase `escape-replay` — scratch project with a nested repo, a done session whose change added a line, a later fix commit with a test that fails before the fix, a replay rule; `forge escapes verify --all` must auto-confirm it; session `forge e2e run` green
