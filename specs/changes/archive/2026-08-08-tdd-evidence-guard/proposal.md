# TDD evidence guard

## Why

Forgekit's TDD core is entirely advisory. Nothing verifies red-before-green;
tier-2 evidence is a command + exit code the coordinator transcribes from the
implementer's report; nothing stops an implementer from editing or deleting
existing tests; and hook wiring is a manual merge step projects skip (finding
F74 — volo: hooks on disk, zero enforcement across 47 subagent dispatches).
The external evidence record (see
`docs/research/2026-08-07-agentic-code-quality-evidence.md`) shows test-gaming
is the highest-severity documented agent failure mode — models delete or
weaken tests and misreport success — and that prompt-level discipline decays
while mechanical gates hold, which matches this repo's own 34-session
scorecard data ("advice decays, gates hold").

## What Changes

- **Test-tamper guard (R1)** — a shared classifier (`guard.mjs`) defines the
  guarded set: test files that existed at the session's `baseCommit`
  (project-configurable globs) plus forge integrity artifacts (`spine.json`,
  `e2e.json`, `e2e-results.json`, `verify-evidence.md`, `test-evidence.md`,
  `tdd-runs.jsonl`). Two enforcement points consume it:
  - a new PreToolUse hook (`forge-test-guard.mjs` on Edit|Write|NotebookEdit)
    that hard-denies edits to guarded files during implement→finish phases,
    fail-open on internal errors;
  - an integrity backstop in `runIntegrityChecks`: guarded files
    modified/deleted vs `baseCommit` without a recorded allowance refuse
    `forge phase done|finish` on every host, wired hooks or not.
  - `forge test-allow <path> --reason "…"` records an allowance in the
    session ledger; allowances surface in reviewer packets and the scorecard.
- **Executed red→green evidence (R2)** — `forge tdd run --task <id>
  --expect fail|pass -- <cmd…>` executes the command itself and appends a
  stamp to `tasks/<id>/tdd-runs.jsonl`; evidence is produced by execution,
  not transcription. Integrity-check requires an ok fail-stamp chronologically
  before an ok pass-stamp per completed task — only for sessions created by
  this version (feature-flagged on the session, no retroactive failures).
- **F74 fix** — `forge init` and `forge doctor --install` idempotently merge
  the hooks snippet into `.claude/settings.json` instead of only writing the
  snippet file, so the guard (and all hooks) ship wired by default.
- Workflow docs and subagent prompts updated: tests are guarded, tier-2
  evidence routes through `forge tdd run`, allowances are
  coordinator-mediated and review-blocking.

Deferred to follow-up changes: independent test-writer subagent (R3),
mutation gate (R4).

## Capabilities

- `test-guard`: guarded-file classifier, allowance ledger, PreToolUse hook,
  integrity backstop — delta at `specs/test-guard/spec.md`
- `tdd-evidence`: executed red→green stamps and the pairing gate — delta at
  `specs/tdd-evidence/spec.md`
- `project-wiring`: init/doctor merge hooks into settings.json — delta at
  `specs/project-wiring/spec.md`

## Impact

- New: `packages/cli/src/guard.mjs`, `guard-cli.mjs`, `test-allow-cli.mjs`,
  `tdd-run.mjs` (+ tests); new hook template
  `templates/project/claude/hooks/forge-test-guard.mjs`.
- Modified: `packages/cli/src/integrity.mjs` (two new checks),
  `new-session.mjs` (feature flag), `init.mjs` + `doctor.mjs` (settings
  merge), `forge.mjs` COMMANDS map, hooks snippet generation, this repo's
  `.claude/settings.json`/hooks, `skills/forge` phase docs and subagent
  prompts.
- Risks: false-positive denials from over-broad test globs (mitigated:
  configurable `guard.testGlobs`, fail-open hook, allowance escape);
  settings.json merge must never clobber user entries (idempotent deep-merge
  + unit tests over real-world shapes); Windows spawn behavior for
  `forge tdd run` (CI covers windows).
- Migration: none for existing sessions — stamp pairing is feature-flagged on
  session creation; existing projects gain the hook on next `forge init`
  or `forge doctor --install`.
