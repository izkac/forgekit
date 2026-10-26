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
- **Regression set:** test files in the hidden tests' directories that exist at base and pass on both base and reference. Calibration runs each file once on base and once on reference, so the run is bounded by those directories.
- **Snapshot:** `git archive <base>` of the nested repo, extracted into `environment/app/`, plus the `--include` paths copied from the operator's checkout. The Dockerfile: `node:22-bookworm` with the same pinned digest as existing tasks, `npm ci` in the rule's `cwd`, then `node -e` to pre-fetch `mongodb-memory-server`'s binary when that package is a dependency.
- **The grader is one template file, `evals/harbor/escape-replays/grader.mjs`.** It is copied into each task's `tests/` with a generated `hidden.json` (paths, sha256, command, cwd). `APP_DIR` and `TESTS_DIR` come from env so the smoke can run it locally without Docker.
- **The registry entry is added at module load only if `local/forgekit-escape-replays-v1/corpus.json` exists.** `taskRootLocator` is `local/forgekit-escape-replays-v1/tasks`.

## Risks / Trade-offs

- Inferred windows can mis-attribute a parallel session's commit. Calibration catches the cases where that changes the outcome (`passes-on-base`, `not-failing-on-head`); others stay. The `inferred` marker is kept in the manifest entry.
- Full calibration on Volo is slow (three test runs per session plus regression files). It runs once per export, in the background.
- Docker images are not built here, so the Dockerfile's `npm ci` and mongod pre-fetch are unproven until the first paid run. The smoke runs the grader without Docker.
