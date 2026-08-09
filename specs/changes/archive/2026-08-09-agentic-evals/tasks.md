# Tasks

## 1. Task contract and smoke fixture

- [x] 1.1 Write `evals/README.md` and `evals/.gitignore` documenting the A/B
      protocol, Harbor installation/commands, external grading rules, metrics,
      task-authoring contract, and the limitation of the smoke task. Verify the
      documented dry-run command and inspect the paths for published-package
      isolation.
- [x] 1.2 Add the `node-health-endpoint` Harbor task under
      `evals/harbor/tasks/`, including `task.toml`, instruction, Node fixture,
      agent Dockerfile, separate verifier Dockerfile, and hidden grader. The
      grader SHALL emit numeric `functional`, `regression`, `tests_unchanged`,
      and `shippable` metrics. Verify the grader against the untouched fixture
      and a known-good reference implementation without running a model.

## 2. Runner and result contract

- [x] 2.1 Implement `evals/harbor/run.mjs` to validate options, stage a
      canonical task into baseline/Forge arms, install the selected Forgekit
      package only in the Forge Dockerfile, inject arm-specific instructions,
      write a run manifest, and invoke Harbor with direct argv (no shell
      interpolation). Verify with unit tests covering both arms, invalid
      versions, repeat/concurrency parsing, and dry-run output.
- [x] 2.2 Implement `evals/harbor/normalize-results.mjs` and its tests. Read a
      Harbor reward JSON plus optional Forge artifact summary and emit a stable
      result record with schema version, arm, task, trial, outcome metrics, and
      instrumentation fields. Missing optional Forge telemetry SHALL be
      represented explicitly rather than treated as a failed task.
- [x] 2.3 Add root developer scripts for the eval unit tests/lint without
      adding Harbor or Python to published package dependencies. Verify the
      existing CLI test/lint commands remain unchanged.

## 3. Executable benchmark loop

- [x] 3.1 Add a local smoke validation script/test that checks the Harbor task
      metadata, builds or validates both staged Dockerfile arms when Docker is
      available, runs the hidden verifier against the fixture, and records the
      expected result shape. It SHALL skip the Docker/model portion with a
      clear message when those tools are unavailable.
- [x] 3.2 Run the Forgekit evaluator unit suite and the full existing workspace
      suite, then record verification evidence and update the README with the
      exact commands and observed limitations.
