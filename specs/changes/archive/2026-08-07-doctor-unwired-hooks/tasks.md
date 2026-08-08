# Tasks

## 1. Hook-wiring check

- [x] 1.1 `packages/cli/src/doctor.mjs`: add `checkHookWiring({ cwd, existsSync?, readFileSync?, readdirSync? })`
      implementing the design contract (surfaces claude + cursor, basename
      match over structurally-walked `command` strings, skipped when no hooks
      dir, failure on missing/unparseable wiring with forge hooks present).
      TDD in `packages/cli/src/doctor.test.mjs`: wired-green, volo-case
      unwired list, partial wiring (helm case), no-hooks-dir skipped,
      settings.local.json counts, malformed settings fails, cursor surface
      wired/unwired. Verify: `node --test packages/cli/src/doctor.test.mjs`.

## 2. Doctor integration

- [x] 2.1 Wire `checks.hooks` into `runDoctorChecks` (both engine branches),
      fold into `ok`, print a `[ok|FAIL]` line in `runDoctor` human output
      with unwired basenames + snippet path, and print the failure in
      `warnIfDoctorFails`. Tests: report shape additive, exit codes (1 on
      unwired, 0 with `--warn-only`), human output contains basenames.
      Verify: `node --test packages/cli/src/doctor.test.mjs`.

## 3. Product loop

- [x] 3.1 Acceptance via the existing harness: add a `doctor-wiring` phase to
      `scripts/e2e/harness-portability.mjs` (and its `all` roster) that drives
      the shipped binary (`packages/cli/bin/forge.mjs`) against a scratch
      project reproducing the volo state — forge hooks on disk,
      `.claude/settings.json` without references — asserting `doctor --json`
      exits 1 with the unwired basenames in `checks.hooks`, then wires the
      settings and asserts exit 0; prints `DOCTOR WIRING GREEN`. Recorded as
      a green `forge e2e run`.
