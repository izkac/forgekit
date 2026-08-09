# Tasks

## 1. Hook command injection (F79)

- [x] 1.1 `templates/project/claude/hooks/forge-prompt-hook.mjs` and
      `forge-triage-hook.mjs`: stop passing untrusted text through a shell.
      Apply the pattern already shipped and reviewed in
      `forge-test-guard.mjs` — `const useShell = process.platform === 'win32'`
      (where `forge` is a `.cmd` shim), argv passed directly on every other
      platform, and hand-quoting confined to the win32 branch. Keep each
      hook's `.claude/hooks/` copy **byte-identical** (a sync test pins this
      for the test-guard hook; add the same for these two if absent).
      TDD: reproduce the injection first — a prompt of
      `hello; touch <marker> #` must create the marker against the current
      code and must not after the fix — then assert the hook still relays a
      prompt containing shell metacharacters (backtick, `$(…)`, `;`, `|`,
      quotes, a newline) to `forge` unchanged. Verify:
      `node --test packages/cli/src/forge-prompt-hook.test.mjs` (create if
      absent; mirror `forge-test-guard.test.mjs`'s child-process style).

## 2. Case-insensitive guard bypass (F90)

- [x] 2.1 `packages/cli/src/guard.mjs`: `makeGitLsTree` folds case in its
      tracked-path lookup on `darwin`/`win32` only, exact elsewhere. Inject
      the platform rather than reading `process.platform` inside the lookup,
      so tests drive both behaviours on a Linux CI runner. TDD in
      `packages/cli/src/guard.test.mjs` (**guarded — request an allowance
      from the coordinator before editing**): under a folding platform,
      `src/A.test.mjs` and `SRC/a.test.mjs` are guarded when
      `src/a.test.mjs` is tracked; under an exact platform they are not;
      an unrelated file is unaffected on both; and a tracked path that
      differs only in case from another tracked path still resolves. Prove
      each by reverting. Verify: `node --test packages/cli/src/guard.test.mjs`.

## 3. Product loop

- [x] 3.1 Extend the existing `test-guard` phase in
      `scripts/e2e/harness-portability.mjs` (do **not** add a new phase —
      this change is two fixes, not a capability) to drive the shipped binary
      through both: a prompt containing shell metacharacters leaves no
      injected artifact, and — on a folding platform, simulated via the
      injected flag rather than the host — a case-variant path is denied.
      Recorded as a green `forge e2e run`.
