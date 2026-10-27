# Delta for Evaluation Corpus

## ADDED Requirements

### Requirement: Confirmed escapes export as a local escape-replay corpus
`evals/harbor/export-escape-replays.mjs --project <path>` SHALL read the project's confirmed escapes and write corpus `forgekit-escape-replays-v1` under `evals/harbor/local/forgekit-escape-replays-v1/`, a path ignored by git. It SHALL write one task per escaped session, never one per fix. The corpus SHALL NOT be written inside the tracked tree, and `corpus-selection.mjs` SHALL register it only when its manifest exists.

#### Scenario: A confirmed escape becomes one task
- **GIVEN** a project whose ledger has a session with two confirmed escapes in one nested repository, an archived change for its slug, and inferred commits for the session
- **WHEN** the operator runs the export with exec allowed
- **THEN** `local/forgekit-escape-replays-v1/corpus.json` lists one task for that session
- **AND** the task's hidden tests are both fixes' test files

#### Scenario: The corpus is not registered without its manifest
- **GIVEN** no local manifest
- **WHEN** the runner selects `forgekit-escape-replays-v1`
- **THEN** selection fails as an unknown corpus before anything runs

#### Scenario: Exported source stays out of git
- **WHEN** the export has written its tasks
- **THEN** `git status --porcelain` in the forgekit checkout lists nothing under `evals/harbor/local/`

### Requirement: The task gives the agent the spec at the session's base
The agent environment SHALL hold the nested repository's tree at the session's base: the parent of its oldest attributed commit. Files that git ignores SHALL NOT be copied, except paths named with `--include`. A named path that is absolute or contains `..` SHALL be refused. The instruction SHALL be the archived change's `proposal.md` followed by its `specs/**/spec.md`, and SHALL NOT contain its `design.md`, `tasks.md`, brief, or any hidden test.

#### Scenario: Ignored secrets are not copied
- **GIVEN** the nested repository has an ignored `server/.env`
- **WHEN** the export runs without `--include`
- **THEN** no task environment contains `.env`
- **AND** with `--include server/.env` the environment does

#### Scenario: Plan output is not in the instruction
- **WHEN** a task's `instruction.md` is written
- **THEN** it contains the proposal and spec text and nothing from `design.md` or `tasks.md`

### Requirement: Every exported task is calibrated
Export SHALL require the exec opt-in. Without it, export SHALL write nothing and exit nonzero. For each session it SHALL build the reference (the escaped head with the fix diffs applied, excluding hidden test files; a fix whose cherry-pick conflicts SHALL be retried once with the fix side winning conflicting hunks, `-X theirs`, and the report SHALL list the fixes applied that way) and run the hidden tests with the recorded replay command in sibling replay worktrees. A task SHALL be kept only when every hidden test fails on the base, fails on the escaped head, and passes on the reference. Every dropped session SHALL be listed in `export-report.json` with one reason: `no-spec`, `no-base`, `unsupported-runner` (no escape of the session has a replay rule), `unsafe-path`, `unsafe-tree` (a symlink, or `export-ignore`/`export-subst` attributes), `missing-test`, `dependency-change` (the reference changes a manifest, lockfile, runner configuration or `.npmrc`/`.yarnrc`/`.yarnrc.yml`), `unpinned-deps` (a replay rule's cwd has no lockfile of its own at the base), `reference-conflict`, `passes-on-base`, `not-failing-on-head`, `not-passing-on-reference`, or `calibration-error`. Calibration SHALL use the same per-test timeout as the verifier. When a replay rule copies ignored files that `--include` does not cover, the report SHALL warn that its tasks cannot be graded without them.

#### Scenario: A test that already passes on the escaped head is dropped
- **GIVEN** a confirmed escape whose hidden test passes on the session's head (the bug came from a later commit)
- **WHEN** the export calibrates it
- **THEN** the session is not in the corpus
- **AND** `export-report.json` lists it with reason `not-failing-on-head`

#### Scenario: Export refuses without the exec opt-in
- **WHEN** the export runs without `FORGEKIT_ALLOW_EXEC=1`
- **THEN** it exits nonzero, names the opt-in, and writes no task

### Requirement: The escape-replay verifier is hidden and solution-independent
Each task SHALL use a separate, no-network verifier environment that holds the hidden test files and the regression set. The agent environment SHALL hold neither. The verifier SHALL copy its own versions of those files over the agent's tree, run them as the untrusted user with the recorded command, using dependencies the verifier image installed from the base manifests (never the agent's), with the application tree read-only and each hidden file restored right before its own run, and write `reward.json`. A test SHALL count as passed only when its command exits 0 and, where the runner's summary is recognised (Jest, Vitest, node --test), it reports at least one passing test and no failures. A command that names one of those three runners must print a summary, and a `node --test` file that ran no test (it reports itself as one passing entry) does not count as a passing test. Calibration judges runs the same way. The reward fields:
- `functional`: every hidden test passes.
- `requirements_met`/`requirements_total`: over the hidden test files.
- `regression`, with `regression_met`/`regression_total`: over the regression set, which is the base test files beside the hidden tests that are identical at base and reference and pass on both.
- `tests_unchanged`: the agent left the regression set's files, the dependency manifests and lockfiles, and the runner configuration unchanged.
- `shippable`: all three binary outcomes.

#### Scenario: The reference solution scores shippable
- **GIVEN** an exported task
- **WHEN** its verifier grades the tree produced by `solution/solve.sh`
- **THEN** `functional`, `regression`, `tests_unchanged` and `shippable` are 1

#### Scenario: Exiting early does not pass
- **GIVEN** an agent tree whose code calls `process.exit(0)` when loaded under the test runner
- **WHEN** the verifier grades it
- **THEN** `functional` is 0

#### Scenario: The untouched base scores not functional
- **WHEN** the verifier grades the unmodified base snapshot
- **THEN** `functional` is 0 and `shippable` is 0
