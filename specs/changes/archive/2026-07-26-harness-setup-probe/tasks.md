# Tasks

## 1. Record and surface setup + probe

- [x] 1.1 Extend `forge e2e harness --set` with `--probe <cmd>` and `--setup <cmd>`
      in `packages/cli/src/e2e.mjs`: parse both flags next to `--start`/`--dir`,
      persist them onto the harness object, and update the usage strings (module
      header comment, `--help` line, the `--set` usage error, the "No harness
      recorded" hint). Test in `packages/cli/src/e2e-cli.test.mjs`: recording
      with both flags writes `e2e.harness.probe` / `e2e.harness.setup` to
      `.forge/config.json` and leaves pre-existing config keys intact.
      Verify: `npm test`.
- [x] 1.2 Print both fields from `harnessLines()` in `packages/cli/src/e2e.mjs`
      as `Setup:` and `Probe:` rows, ordered Setup → Start → Probe → Location so
      the lines read in the order an operator executes them. Setup carries a
      short "(this machine, once per checkout)" qualifier. Test: `forge e2e
      harness` and `forge e2e init` both show the new rows; a harness recorded
      without them prints neither row (no empty labels).
      Verify: `npm test`.

## 2. Attribute failing steps to missing prerequisites

- [x] 2.1 In the `run` branch of `packages/cli/src/e2e.mjs`, after the step list
      prints and when `results.ok` is false, print the recorded
      `e2e.harness.setup` as a suspicion block before the `FAILED` line. Only
      when a setup is recorded; must not alter the exit code. Test in
      `packages/cli/src/e2e-cli.test.mjs`: a failing loop in a project with a
      recorded setup prints the setup command; the same failing loop with no
      recorded setup prints no hint; a green loop with a recorded setup prints
      no hint.
      Verify: `npm test`.

## 3. Teach the portability rule

- [x] 3.1 Update the harness recording block in
      `skills/forge/references/runtime-integrity.md` (the "A built harness is
      permanent project infrastructure" bullet): new flags in the command
      snippet, plus the rule that anything the agent installed to make the probe
      pass must be recorded as `setup` because a harness proven only in the
      agent's environment is not proven.
      Verify: rendered wording reads as an invariant, not a Playwright note.
- [x] 3.2 Update both command templates
      (`templates/project/claude/commands/forge-harness.md`,
      `templates/project/cursor/commands/forge-harness.md`): step 1 verification
      uses the recorded probe, step 3 "Build and prove" gains the
      operator-machine bullet, step 4 records the new flags. Keep the two files
      consistent — they differ only in frontmatter.
      Verify: `diff` the bodies; `grep -c` the new flags in each.
- [x] 3.3 Update `docs/usage.md` (e2e command reference) and add a `CHANGELOG.md`
      entry under a new Unreleased/next-version heading matching existing style.
      Verify: `npm run lint && npm test`.

## 4. Product loop acceptance

- [x] 4.1 Write `scripts/e2e/harness-portability.mjs` — the executable product
      loop behind `e2e.json`. Drives the shipped binary
      (`packages/cli/bin/forge.mjs`), not the src modules, against a scratch
      project in a temp dir with an isolated `FORGEKIT_FLEET_DIR`. Phases:
      `boot` (scratch project + session fixture), `record` (harness --set with
      the new flags, then read back `.forge/config.json`), `show`
      (`forge e2e harness` + `forge e2e init`), `red-run` (failing loop with a
      recorded setup), `quiet-cases` (green-with-setup and red-without-setup).
      Windows-safe: no POSIX-only shell, paths normalized like the existing
      `--repeat` test fixture.
      Verify: `forge e2e run` green on all five steps.
- [x] 4.2 Record the script as this repo's own project harness with the new
      flags — forgekit currently has none, so `forge e2e init` prints no harness
      block. Dogfoods the change end to end.
      Verify: `forge e2e harness` shows Start/Probe/Location. No `setup` is
      recorded — forgekit needs nothing machine-local beyond node, and an
      absent field is what the design supports.
