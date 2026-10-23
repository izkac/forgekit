# Tasks

## 1. Seal refresh hardening
- [x] 1.1 `packages/cli/src/integrity-seal.mjs`: write the seal via tmp + rename; retry compute+write up to 3× on EBUSY/EPERM/EACCES with sync backoff. Test in new `integrity-seal-retry.test.mjs` (existing test files are guarded): injected writer failing once with EBUSY → seal written and `checkIntegritySeal` clean.

## 2. Tier-3 stamp scope and verdict
- [ ] 2.1 `packages/cli/src/record-evidence.mjs`: parse `--scope full|failed-only|fix|group` (default full; invalid value or `--scope` without `--tier3` → usage error, nothing spawned); store `scope` in the stamp; receipt shows scope. Tests in new `record-evidence-scope.test.mjs`.
- [ ] 2.2 `packages/cli/src/proven.mjs`: verdict from last `full` stamp (missing scope = full); red full + later green `failed-only` → ok with `via: 'failed-only'`; fix/group never flip; per-scope counts; status summary line names the rescue. Tests for the four spec scenarios in new `proven-tier3-scope.test.mjs`.

## 3. Cross-session tier-3 lock
- [ ] 3.1 New `packages/cli/src/tier3-lock.mjs`: `lockPathFor(cwd)` (git common dir → `<common>/forge/tier3.lock`, else `.forge/tier3.lock`); `acquireTier3Lock({ cwd, sessionId, slug, pollMs, notify })` with wx create, holder JSON, dead-pid and old-unparseable takeover, wait loop with holder message, fail-open on other errors; release only if the file names our pid. Tests in `tier3-lock.test.mjs`: acquire/release; waits while a live child process holds it and proceeds after release; dead-pid takeover; unwritable dir → warning + no-op release; two worktrees of one repo resolve the same lock path.
- [ ] 3.2 Wire into `record-evidence.mjs`: only `--tier3` with scope `full` acquires; release in `finally` and on exit/SIGINT/SIGTERM. Tests in new `record-evidence-lock.test.mjs`: scope `group` runs while a lock is held; a full run stamps after the holder releases.

## 4. Nested-repo base commits
- [ ] 4.1 `packages/cli/src/new-session.mjs`: scan depth ≤2 (skip `node_modules`, dot-dirs) for dirs with a `.git` entry; record `session.nestedBaseCommits` keyed by posix rel path; omit unreadable HEADs; absent when none. `session-status.mjs` shows it. Tests in new `new-session-nested.test.mjs`: nested repo recorded; none → absent.

## 5. Skill and docs: full suites run once
- [ ] 5.1 `skills/forge/references/test-strategy.md`: add the group tier (diff-related tests, Jest `--changedSince=<base>`, Vitest `run --changed <base>`, base from `baseCommit` / `nestedBaseCommits`, `--scope group`; harness/config touch → note for verify; runner blind spots → explicit paths, listed in project AGENTS.md); replace the line-49 re-run rule with failed-only / fix rules; update the quick-reference table.
- [ ] 5.2 `skills/forge/phases/verify.md`: leftover sweep before tier 3; tier 3 once per workspace, one after another; replace step 4 (~line 176) and "When to re-run tier 3" (~lines 199-209) with failed-only / fix rules; document `--scope` and the lock; e2e note (the change's steps only, a project's full smoke suite belongs in CI).
- [ ] 5.3 `skills/forge/skills/verification-before-completion/SKILL.md` (lines 21/28) and `skills/forge/skills/specs-verify-change/SKILL.md` (line 117): same rules; sweep before tier 3.
- [ ] 5.4 `skills/forge/phases/implement.md` (group-close test step), `phases/close.md`, `subagents/closer-prompt.md`, `subagents/final-reviewer-prompt.md` (check failed-only covers the red run's failures), `docs/forge.md` (CLI listing + test tiers), `SKILL.md` testing line, `CHANGELOG.md` Unreleased. Verification: `grep -rn "edited code after" skills/forge` returns no re-run-tier-3 instruction.

## 6. Product loop
- [ ] 6.1 `scripts/e2e/harness-portability.mjs`: add a `tier3-lock` subcommand. Scratch git repo + a linked worktree, each with a Forge session; start `forge evidence --tier3 -- node -e <sleep 3s>` in both concurrently (`FORGEKIT_ALLOW_EXEC=1`); assert the runs did not overlap (stamp start/duration) and the second printed the waiting line; assert a `--scope group` run during a held lock does not wait; stamp a red full then a green failed-only and assert `forge status` reads tier 3 ok via failed-only. Prints `TIER3 LOCK GREEN`. Evidence: `forge e2e run`.
