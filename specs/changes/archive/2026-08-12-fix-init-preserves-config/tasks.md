# Tasks

## 1. Preserve the recorded plan engine

- [x] 1.1 Red test in `packages/cli/src/init.test.mjs` (or the init resolver's
      test file): a project whose `.forge/config.json` records
      `plan.engine: specs` / `plan.dir: specs`, resolved with no engine flag and
      the user default set to openspec, resolves to `specs` and keeps
      `plan.dir: specs`. Verify: the test fails first.
- [x] 1.2 In `resolveInitPlanEngine` (`packages/cli/src/init.mjs`), read the
      recorded engine via `loadProjectConfig` and honor a *present*
      `plan.engine` before the `configured` / user-default branches; treat an
      absent key as fall-through (do not use `resolveProjectPlanEngine`'s
      openspec last-resort as if it were a recorded value). Preserve the recorded
      `plan.dir`. Verify: 1.1 passes.
- [x] 1.3 Test that an explicit `--openspec` still converts a recorded-specs
      project, and `--no-openspec` still forces specs — flags outrank recorded
      config. Verify: `node --test packages/cli/src/init.test.mjs`.
- [x] 1.4 Test the no-config first-run: a project with no `.forge/config.json`
      and a user openspec default still resolves to openspec (behavior
      unchanged). Verify: `node --test packages/cli/src/init.test.mjs`.
- [x] 1.5 Preserve a recorded *custom* `plan.dir`. `resolveInitPlanEngine`
      returns only the engine string, so `main()` decides the dir later and
      `scaffoldSpecs` defaults to `DEFAULT_SPECS_DIR` unless `--plan-dir` is
      passed — a recorded `plan.dir: docs/specs` still resets to `specs` on a
      flagless re-init. Red test: a project recording `plan.engine: specs` /
      `plan.dir: docs/specs`, re-inited non-TTY with no flag, keeps
      `plan.dir: docs/specs`. Then in `main()` (the `opts.adr === null` region,
      near the `resolveInitPlanEngine` call), when no `--plan-dir` was given and
      the resolved engine is specs, default `opts.planDir` from the recorded
      `plan.dir`. Verify: `node --test packages/cli/src/init.test.mjs`.

## 2. Preserve the recorded ADR setting

- [x] 2.1 Red test: a project recording `adr.enabled: false`, re-inited non-TTY
      with the user global ADR enabled and no `--adr/--no-adr` flag, keeps
      `adr.enabled: false` and creates no ADR scaffold. Also assert the mirror:
      a recorded `adr.enabled: true` survives a user default that disables ADRs.
      Verify: the test fails first.
- [x] 2.2 In the ADR resolution block of `init.mjs` (where `opts.adr === null`),
      read the project's recorded `adr.enabled` via `loadProjectConfig` and honor
      it before the user/prompt/non-TTY path. Absent → existing behavior. Verify:
      2.1 passes.

## 3. Product loop

- [x] 3.1 Add an `init-preserves-config` case to
      `scripts/e2e/harness-portability.mjs` (reuse it — do not build a new
      harness), following the dispatcher pattern. On a throwaway project it SHALL:
      write a `.forge/config.json` recording specs + `adr.enabled: false`, run
      the shipped `forge init --claude` non-TTY with a user config defaulting to
      openspec + ADRs on, then assert the recorded config is unchanged and no
      stray ADR files were scaffolded. Add it to `ALL_ROSTER` and the usage
      string. Print `INIT PRESERVES CONFIG GREEN`. Verify:
      `node scripts/e2e/harness-portability.mjs init-preserves-config`.
- [x] 3.2 Run the full product loop green and current. Verify: `forge e2e run`
      exits 0 with all steps passing.
