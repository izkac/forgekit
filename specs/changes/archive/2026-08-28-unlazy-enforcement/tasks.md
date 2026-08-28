# Tasks

## 1. Stop hook template

- [x] 1.1 Write `templates/project/claude/hooks/forge-stop-hook.mjs` per
      design D1 (stdin parse, `stop_hook_active` guard, fs-only fast path,
      claim-state test, `hooks.stopGate` off-switch, integrity-check spawn,
      `{"decision":"block"}` emission, fail-open on every error path).
      Tests first: new `packages/cli/src/forge-stop-hook.test.mjs` driving
      the template as a child process against fixture sessions (pattern:
      `forge-test-guard.test.mjs`) — cases: no session, mid-implement open
      tasks (allow, no spawn), claim-state red (block JSON), claim-state
      green (allow), `stop_hook_active` (allow), `stopGate: "off"` (allow),
      corrupt session.json (allow).
- [x] 1.2 Wire `Stop` event into the settings snippet + instructions string
      in `packages/cli/src/init.mjs` (~L478); extend `init.test.mjs` to
      assert the Stop entry and hook file install.

## 2. Gate CLI (opt-in)

- [x] 2.1 New `packages/cli/src/gate.mjs`: `forge gate init|check|status`
      per design D2 — gates.json scaffold from `tasks.md` `##` groups,
      check runner reusing the e2e step runner from `integrity.mjs`,
      session `gate-results.json` with per-group `checksHash`, opt-in wall
      on `gates.enabled`. Tests first: `packages/cli/src/gate.test.mjs`
      (disabled wall, init scaffold, green/red/stale check, status output).
- [x] 2.2 Route `gate` in `packages/cli/bin/forge.mjs` command table + help
      text; assert routing in existing CLI help test if present.

## 3. Integrity integration

- [x] 3.1 `runIntegrityChecks` in `packages/cli/src/integrity.mjs`: when
      `gates.enabled` AND gates.json has non-empty checks AND
      tasksComplete >= tasksTotal, require green + current gate-results per
      group; otherwise untouched. Tests in `integrity.test.mjs`: flag off →
      ignored; enabled + partial tasks → ignored; enabled + all tasks +
      red/stale/missing → problem; green → ok.

## 4. Evidence fingerprints

- [x] 4.1 Step runner records `outputSha256`, resolved `cwd`, `shell` per
      step (e2e + gate results). Extend runner tests in `integrity.test.mjs`
      / `e2e-cli.test.mjs` to assert the fields; existing readers unaffected.

## 5. Docs, vendor sync, product loop

- [x] 5.1 Docs: `skills/forge/references/runtime-integrity.md` (opt-in gates
      section + untrusted-artifact paragraph), `skills/forge/phases/implement.md`
      (coordinator re-verify rule, design D4), `skills/forge/SKILL.md`
      guardrails line, `skills/forge/docs/forge.md` (stop hook + gates),
      `CHANGELOG.md` entry. Verified by existing doc-drift tests
      (`pace-doc-drift.test.mjs` etc.) staying green.
- [x] 5.2 Write `scripts/e2e/unlazy-enforcement-loop.mjs` (scratch-project
      loop over the shipped CLI, pattern: `scripts/e2e/harness-portability.mjs`)
      with subcommands `stop-blocks`, `stop-allows`, `gates-loop`,
      `fingerprints` printing sentinel tokens; run vendor sync
      (`node packages/cli/scripts/prepack.mjs`) so templates/skills vendor
      copies match source.
- [x] 5.3 Product-loop acceptance: green `forge e2e run` on this change's
      `e2e.json` (stop hook blocks on red / allows fast path; gates loop
      green flips integrity; fingerprints present in results).
