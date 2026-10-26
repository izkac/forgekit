# Tasks

## 1. Export scaffold
- [x] 1.1 `.gitignore` adds `evals/harbor/local/`; `corpus-selection.mjs` registers `forgekit-escape-replays-v1` (manifest `local/forgekit-escape-replays-v1/corpus.json`, task root `local/forgekit-escape-replays-v1/tasks`) only when the manifest exists; tests: unknown without the manifest, selected with one
- [x] 1.2 `evals/harbor/export-escape-replays.mjs`: refuse without `FORGEKIT_ALLOW_EXEC=1` (nonzero, no output); group confirmed escapes per session; pick repo; base/head from `nestedCommitRanges` or inferred commits; archived change by slug (`openspec/changes/archive/*-<slug>` or `specs/changes/archive/*-<slug>`); drop reasons `no-spec`, `no-base`, `unsupported-runner`; instruction = proposal + specs only; snapshot via `git archive` + `--include` (refuse absolute / `..`); tests in temp repos with a nested repo (ignored `.env` absent by default, present with `--include`; instruction has no design/tasks text)

## 2. Calibration and verifier
- [ ] 2.1 Reference build (cherry-pick fixes onto head in a replay worktree, hidden tests restored to head) and calibration runs base/head/reference with drop reasons `reference-conflict`, `passes-on-base`, `not-failing-on-head`, `not-passing-on-reference`; regression set; `export-report.json`; tests with a temp repo whose replay rule runs `node --test`
- [ ] 2.2 Task writer: `task.toml` (separate no-network verifier), `environment/Dockerfile` (pinned node image, npm ci, mongod prefetch when depended on), `tests/` (Dockerfile, test.sh, `escape-replays/grader.mjs` template, `hidden.json`, hidden + regression files), `solution/solve.sh` + reference patch, `corpus.json`; grader: reward keys + counts, untrusted user, `APP_DIR`/`TESTS_DIR` env; tests: grader on the reference tree → shippable 1, on base → functional 0, on a tree that edits a regression file → tests_unchanged 0

## 3. Smoke, docs and live export
- [ ] 3.1 `evals/harbor/smoke-escape-replays.mjs`: scratch project with a nested repo, an archived spec, a done session, a confirmed escape and a `node --test` replay rule; export into a temp out dir; grade reference and base locally; `npm run smoke:evals:escape-replays`; session `forge e2e run` green
- [ ] 3.2 `evals/README.md` section (what the corpus is, privacy, how to export, that trials are a separate paid step); CHANGELOG Unreleased (docs-only, `--no-tdd`)
- [ ] 3.3 Live export against Volo with exec allowed (background); record kept/dropped counts by reason in verify evidence; confirm `git status` shows nothing under `evals/harbor/local/`; no Docker builds, no trials
