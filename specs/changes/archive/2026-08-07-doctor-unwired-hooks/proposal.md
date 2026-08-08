# Doctor detects forge hooks present on disk but unwired

## Why

`forge init` scaffolds hook files into a project's `.claude/hooks/` (and
`.cursor/hooks/`) and writes `.claude/forge-hooks.snippet.json`, but merging
that snippet into `.claude/settings.json` is a manual step. When the merge
never happens, every enforcement surface that rides on hooks — subagent model
policy, the dispatch ledger, session-start reminders, triage — is silently
off. This is not hypothetical: the volo project ran 47 subagents with 0
dispatches recorded (all four hooks on disk, none wired), and helm ran its
entire session history with only the PreToolUse hook wired. Nothing in the
product detects this state today; it was found by a manual cross-project
audit (`.forge/reports/analysis-2026-08-07.md`).

## What Changes

- `forge doctor` gains a **hook-wiring check**: for each agent surface whose
  hooks directory exists, every `forge-*.mjs` hook file on disk must be
  referenced by that surface's wiring file. Unwired hooks fail doctor with
  the exact basenames and the snippet path to merge.
- `warnIfDoctorFails` (the warn-only path `forge new` already calls) prints
  the same finding, so an unwired project warns at every session start.
- `forge init` behaviour is unchanged (auto-merge is tracked separately as a
  finding, kind=idea).

## Capabilities

- `project-wiring`: hook-wiring detection — delta at
  `specs/project-wiring/spec.md`

## Impact

- `packages/cli/src/doctor.mjs` — new check + report field `checks.hooks`,
  human output lines, exit-code contribution.
- `packages/cli/src/doctor.test.mjs` — new cases.
- Additive report shape: existing `checks.project` / `checks.cli` consumers
  unaffected. `forge doctor` may now exit 1 in projects that previously
  passed while unwired — that is the point.
