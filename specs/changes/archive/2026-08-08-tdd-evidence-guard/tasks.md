# Tasks

## 1. Guard classifier + allowance ledger

- [x] 1.1 `packages/cli/src/guard.mjs`: `classifyGuarded({ relPath, session,
      config, gitLsTree })` per design D2/D8 (default globs, config override
      `guard.testGlobs`, baseline membership via injected `gitLsTree`,
      always-guarded integrity artifacts, posix path normalization) and
      `loadAllowances(sessionDir)` / `addAllowance(sessionDir, { path,
      reason, phase })` with mandatory non-empty reason. TDD in
      `packages/cli/src/guard.test.mjs`: glob defaults and overrides,
      baseline-tracked vs session-created file, integrity artifacts guarded
      regardless of age, rename delete-side, windows path input, allowance
      round-trip, empty-reason refusal.
      Verify: `node --test packages/cli/src/guard.test.mjs`.

## 2. Guard CLI

- [x] 2.1 `packages/cli/src/guard-cli.mjs`: `forge guard check --file <path>
      [--json]` — exit 0 allow / 2 deny / 1 internal error; fast-allow per
      D8 (no session, pre-implement or terminal phase, unguarded, allowance);
      deny message names matched glob + `forge test-allow` escape. Register
      `guard` in `packages/cli/bin/forge.mjs` COMMANDS. Tests in
      `guard-cli.test.mjs` cover the decision table end-to-end in a scratch
      repo. Verify: `node --test packages/cli/src/guard-cli.test.mjs`.
- [x] 2.2 `packages/cli/src/test-allow-cli.mjs`: `forge test-allow <path>
      --reason "<text>"` — gate-class session resolution (refuse on
      ambiguity), appends to `guard-allowances.json`, prints recorded entry.
      Register `test-allow` in COMMANDS. Tests: ledger append, ambiguous
      session refusal, missing reason refusal.
      Verify: `node --test packages/cli/src/test-allow-cli.test.mjs`.

## 3. PreToolUse hook

- [x] 3.1 `templates/project/claude/hooks/forge-test-guard.mjs`: PreToolUse
      handler for Edit|Write|NotebookEdit — extract target path from hook
      stdin payload, spawn `forge guard check`, deny on exit 2 with the CLI's
      message, allow (with stderr warning) on any other failure (D3). Add the
      hook to the snippet generation in `packages/cli/src/init.mjs` and to
      this repo's `.claude/settings.json` + `.claude/hooks/`. Tests
      (`forge-test-guard.test.mjs` or extend hook tests): payload parsing per
      tool, deny mapping, fail-open on spawn error/exit 1.
      Verify: `node --test packages/cli/src/forge-test-guard.test.mjs`.

## 4. Integrity backstop

- [x] 4.1 `packages/cli/src/integrity.mjs`: new check `guardedFiles` — diff
      guarded set between `session.baseCommit` and worktree (modified or
      deleted, staged or not); entries without a matching allowance become
      integrity problems refusing `forge phase done|finish`. Reuses
      `classifyGuarded`. Tests in `integrity.test.mjs`: clean pass, tampered
      test refusal, allowance clears it, session-created test edits pass,
      missing baseCommit degrades to skip with warning.
      Verify: `node --test packages/cli/src/integrity.test.mjs`.

## 5. Executed red→green evidence

- [x] 5.1 `packages/cli/src/tdd-run.mjs`: `forge tdd run --task <nn-slug>
      --expect fail|pass [--] <cmd…>` per design D5 (spawn shell:false,
      repo-root cwd, stamp append with CLI-side timestamps, contradiction
      recorded + non-zero exit, task dir created). Register `tdd` in
      COMMANDS. Tests: fail-stamp ok, pass-stamp ok, contradicted expect
      (both directions), stamp schema, missing task arg refusal, windows
      spawn. Verify: `node --test packages/cli/src/tdd-run.test.mjs`.
- [x] 5.2 `packages/cli/src/new-session.mjs`: write `features: { tddEvidence:
      true }` on session creation. `packages/cli/src/integrity.mjs`: when
      flag present, require per completed task dir an ok fail-stamp
      chronologically before an ok pass-stamp (`tdd-runs.jsonl`); absent flag
      → skip. Tests: pair present passes, missing red refuses, wrong order
      refuses, legacy session (no flag) skips.
      Verify: `node --test packages/cli/src/integrity.test.mjs`.

- [x] 5.3 Close the two gaps review found between the gate and the rest of
      the toolkit. `packages/cli/src/record-evidence.mjs`: accept
      `--no-tdd --reason "<text>"`, recording the declaration in
      `test-evidence.md`. `packages/cli/src/integrity.mjs`: `checkTddEvidence`
      honors that declaration (declared exemption only — evidence alone stays
      gated). `packages/cli/src/score.mjs`: `listTaskEvidence` counts a task
      dir as carrying tier-2 evidence when it holds `test-evidence.md` **or**
      an ok pass-stamp in `tdd-runs.jsonl`. Tests: docs-only task deadlock
      (reproduce first — it currently refuses `forge phase done`), exemption
      clears it, undeclared evidence still gated, red→green-only task scores
      as covered. Verify: `node --test packages/cli/src/integrity.test.mjs
      packages/cli/src/score.test.mjs packages/cli/src/record-evidence.test.mjs`.

## 6. F74 — init wires hooks

- [x] 6.1 `packages/cli/src/init.mjs`: pure `mergeHooksIntoSettings({
      settings, snippet })` per design D7; `forge init` merges into
      `.claude/settings.json` (create when missing; on unparseable JSON
      refuse-and-instruct, never overwrite). `packages/cli/src/doctor.mjs`:
      `--install` performs the same merge. Tests in `init.test.mjs` +
      `doctor.test.mjs`: fresh project, existing user hooks preserved,
      idempotent re-run, malformed settings refusal, doctor --install parity.
      Verify: `node --test packages/cli/src/init.test.mjs
      packages/cli/src/doctor.test.mjs`.

## 7. Docs and prompts

- [x] 7.1 Update `skills/forge/references/tdd-core.md` and
      `skills/forge/phases/implement.md`: tier-2 evidence routes through
      `forge tdd run` (red stamp before implementation, green stamp after);
      guarded-file rules and the allowance flow; `forge evidence` reserved
      for non-TDD artifacts. Update
      `skills/forge/subagents/implementer-prompt.md`
      and `task-reviewer-prompt.md`: implementers surface guarded-file needs
      via NEEDS_CONTEXT (never `forge test-allow` themselves); reviewers get
      open allowances listed. Update `docs/usage.md` command table. Verify:
      `node --test packages/cli/src/review-guidance-contract.test.mjs` (doc
      contract suite still green) and grep-based doc assertions where the
      suites pin phrases.

## 8. Product loop

- [x] 8.1 Acceptance via the harness: add `test-guard` and `tdd-evidence`
      phases to `scripts/e2e/harness-portability.mjs` (and the `all` roster)
      driving the shipped binary in a scratch project — `forge init` merges
      hooks into `.claude/settings.json` (F74, exit-0 doctor); guard denies
      an edit to a baseline test via `forge guard check` (exit 2) and allows
      after `forge test-allow`; `forge tdd run` records red→green and
      `integrity-check` refuses without the pair / without allowance and
      passes with both; prints `TEST GUARD GREEN` / `TDD EVIDENCE GREEN`.
      Recorded as a green `forge e2e run`.
