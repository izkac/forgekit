# Close the escape-tracking gaps

## Why
Escape tracking is the primary measure of Forge's Promise, but on the project with the most
history it measures nothing. Volo's code lives in nested git repos (`volo_web`, `volo_mobile`),
while `forge phase done` records a Commit range only for the repo `forge` runs in, so every code
escape there is invisible. Confirming a candidate is manual (34 are waiting fleet-wide), and the
ledger records neither the forgekit version nor which model coordinated, so a trend change cannot
be tied to a release or a model.

## What Changes
- **Commit range per repository:** at done, record a range for each nested repo `forge new` saw
  (unchanged repos omitted); `forge escapes` searches every repo. Sessions recorded before this
  get ranges inferred from their time window, marked `inferred`.
- **`forge escapes verify`:** runs a candidate's fix-commit test against the code before the fix
  and against the fix, in throwaway worktrees, using a recorded `escapes.replay` rule. Old fails and
  fix passes → auto-confirmed; anything else is tagged (`not-reproduced`, `environment`) or left
  undecided, never dismissed. Needs the exec opt-in.
- **Ledger:** `forgekitVersion` and `models: { coordinator, subagents }` per session;
  `forge escapes report --by version`.
- **Glossary:** **Commit range** becomes per repository.

## Capabilities
- `escape-tracking`: per-repository ranges, time-window inference, replay verification, report by version — delta at `specs/escape-tracking/spec.md`
- `session-metrics`: forgekit version and coordinator/subagent models in the digest — delta at `specs/session-metrics/spec.md`

## Impact
- CLI: `set-phase.mjs` (record nested ranges at done), `escapes.mjs` (per-repo search, inference,
  report by version), new `escapes-replay.mjs` (worktree runner + classification),
  `escapes-cli.mjs` (`verify`, `--by version`), `ledger.mjs` + `metrics/collect.mjs` (version,
  models).
- Executes project test commands only on explicit `forge escapes verify`, behind the existing exec
  opt-in, in throwaway worktrees outside the operator's working tree.
- Config: new optional `escapes.replay` rules and `escapes.replayTimeoutSec` in `.forge/config.json`.
- Docs: `CONTEXT.md`, `docs/usage.md`, `skills/forge/docs/forge.md`, CHANGELOG.
