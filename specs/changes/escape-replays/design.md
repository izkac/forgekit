# Design

## Context

Confirmed escapes live in `<project>/.forge/escapes.jsonl` (`decision: confirmed`, `repo`, `commit`, `replayTest`, `command`). The session digest in `.forge/sessions.jsonl` carries `nestedCommitRanges`, or nothing. For the latter, `inferNestedWindows` in `packages/cli/src/escapes.mjs` attributes commits by time window. Replay machinery is in `packages/cli/src/escapes-replay.mjs`: `resolveReplayRule`, `replayArgv`, sibling-folder worktrees, `node_modules` linking, `copyIgnored`, and timeouts. Harbor tasks follow `evals/harbor/tasks/pagination-boundary/`: task.toml 1.4, a separate verifier, and the four reward keys plus counts.

## Decisions

- **The exporter is a repo-only script, `evals/harbor/export-escape-replays.mjs`.** It imports the CLI's escapes and replay modules by relative path.
  - Alternatives considered: a published `forge escapes export` subcommand.
  - Rationale: the corpus is an eval concern, and its output path is the forgekit checkout, which a globally installed CLI cannot locate.
- **Base, head and reference.** Each session uses one repository: the repo of its confirmed escapes. A session with confirmed escapes in two repos uses the repo with most, and the other repo's escapes are reported as `unsupported-runner`.
  - The commits come from `nestedCommitRanges[repo]` when recorded, otherwise from inferred commits.
  - head = newest commit. base = range base, or else the parent of the oldest inferred commit.
  - reference = head with each fix commit cherry-picked in order (`git cherry-pick --no-commit`, run in a replay worktree), then the hidden test files restored to head's versions. A conflict gives `reference-conflict`.
  - The `solve.sh` patch is `git diff --binary base reference -- . ':!<hidden tests>'`.
- **Hidden tests** are each fix's `replayTest` taken at the fix commit. When two fixes touch one file, the newest fix's version is used. The command is the ledger's recorded `command`, re-derived with `replayArgv` and the project's rule, and stored per hidden test with its `cwd`. The verifier is runner-agnostic: it runs each test's argv. An escape whose test has no rule is `unsupported-runner`. (Amended at group 1 close: the Volo verify rerun confirmed 134 escapes, 94 of them client Vitest, so a Jest-only filter would drop most of the corpus.) The Dockerfile runs `npm ci` in every distinct rule `cwd` used by the task.
- **Calibration order:** base must fail, then head must fail, then reference must pass. This is three runs per session in sibling worktrees, with `copyIgnored` for the rule's `copy` list (calibration needs `.env`; the exported snapshot gets it only via `--include`).
- **Regression set:** test files in the hidden tests' directories that exist at base, are the same blob at base and in the reference tree, and pass on both (amended at group 2 close: the verifier grades the base bytes, so a file the session or a fix rewrote cannot be in it). Calibration runs each file once on base and once on reference, so the run is bounded by those directories.
- **Snapshot:** `git archive <base>` of the nested repo, extracted into `environment/app/`, plus the `--include` paths copied from the operator's checkout. The Dockerfile: `node:22-bookworm` with the same pinned digest as existing tasks, `npm ci` in the rule's `cwd`, then `node -e` to pre-fetch `mongodb-memory-server`'s binary when that package is a dependency.
- **The grader is one template file, `evals/harbor/escape-replays/grader.mjs`.** It is copied into each task's `tests/` with a generated `hidden.json` (paths, sha256, command, cwd). `APP_DIR` and `TESTS_DIR` come from env so the smoke can run it locally without Docker.
- **The verifier does not trust the agent's runner (amended at group 2 close).** The agent controls the code a test runner loads, so a bare exit code is not a verdict.
  - The verifier image installs its own dependencies from the base manifests and lockfiles, copied to `tests/deps/<cwd>/`, under `/opt/verifier-deps` (readable by the untrusted user, unlike `/tests`), with its own mongod prefetch. The grader removes every `node_modules` under `/app` (without following links) and links the verifier's at each rule cwd. A base tree that tracks a `node_modules/` path would lose it in grading; Volo tracks none, so this is a documented limit, not a drop reason. The artifact stays `/app/` whole (the Forge arm's `.forge/` travels with it), so the agent's `node_modules` come along unused.
  - Manifests, lockfiles and runner configs (`jest|vitest|vite|babel.config.*`, `.babelrc*`, `tsconfig*.json`) of each rule cwd are hashed into `tests_unchanged`, and a config of those names that the base lacks counts as a change. The same holds for `.npmrc`, `.yarnrc` and `.yarnrc.yml`, taken from the cwd and each ancestor up to the repository root (base versions, from git objects) and also copied into `tests/deps/` at their relative paths, so the verifier's install sees the registry settings the base had. A reference that changes any of them is dropped as `dependency-change`.
  - `/app` is root-owned and read-only while tests run; the runner gets a fresh writable HOME, TMPDIR and XDG_CACHE_HOME per run. Each hidden or regression file is restored just before its own run.
  - A test passes on exit 0 plus, where the runner prints a summary, at least one pass and no failure (`escape-replays/outcome.mjs`, shared with calibration). Jest, Vitest and `node --test` commands must print one; a `node --test` file that ran no test (the code exited early) does not count.
  - One per-test timeout, `DEFAULT_REPLAY_TIMEOUT_SEC`, serves calibration and the grader; the verifier timeout is derived from it.
- **Threat model: non-adversarial.** The corpus measures honest attempts, not tamper resistance.
  - Agent code runs in the same process as the assertions, so it can patch `node:assert` or `expect`, or plant a nested babel config. A runner summary it forges is believed (`outcome.mjs`). Hashing the manifests and runner configs, removing every agent `node_modules`, and the read-only `/app` close the cheap routes, not these.
  - The HTTP-checked corpora differ: their checks run in the verifier against a service, outside the agent's process. Here the closing step would be a runner-owned reporter per runner, which is out of scope.
  - Calibration links the operator's current `node_modules` into its worktrees, while the verifier installs from the base lockfile. A test can pass in calibration and fail in the verifier (or the reverse) when the operator's installed versions have drifted from the lockfile. This is an approximation; the first paid run shows how often it matters.
  - A rule cwd with no lockfile of its own would resolve whatever is newest at build time, so its session is dropped as `unpinned-deps`.
- **The registry entry is added at module load only if `local/forgekit-escape-replays-v1/corpus.json` exists.** `taskRootLocator` is `local/forgekit-escape-replays-v1/tasks`.

## Risks / Trade-offs

- Inferred windows can mis-attribute a parallel session's commit. Calibration catches the cases where that changes the outcome (`passes-on-base`, `not-failing-on-head`); others stay. The `inferred` marker is kept in the manifest entry.
- Full calibration on Volo is slow (three test runs per session plus regression files). It runs once per export, in the background.
- Docker images are not built here, so the Dockerfile's `npm ci` and mongod pre-fetch are unproven until the first paid run. The smoke runs the grader without Docker.
