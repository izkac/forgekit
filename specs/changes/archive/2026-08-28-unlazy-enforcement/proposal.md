# Unlazy Enforcement

## Why

Comparison with the unlazy skill exposed a structural gap: every Forge
integrity gate fires only when the agent chooses to run `forge phase done`.
Nothing stops an agent from telling the user "done" in chat without ever
taking the gate. Secondary gaps: task-group completion is self-certified
prose (machine checks exist only at change level via `e2e.json`), and the
implement-phase coordinator trusts subagent completion reports instead of
re-running their evidence.

Hard constraint from the operator: **no added cost or time to normal Forge
session execution**. Anything with real per-session overhead is opt-in.

## What Changes

- **Stop-gate backstop** (Claude Code): new `forge-stop-hook.mjs` project
  hook template + `Stop` event wiring in `forge init --claude`. Blocks
  turn-end only when the session claims completion (all tasks ticked, or
  phase in verify/review/finish) while `forge integrity-check` fails.
  Fast path is pure fs reads (<50ms, no spawn); fails open on any error;
  honors `stop_hook_active` (never blocks twice in a row); off-switch
  `.forge/config.json → hooks.stopGate: "off"`.
- **Per-group task gates** (opt-in, `gates.enabled` default off): new
  `forge gate init|check|status` subcommand. `gates.json` in the change dir
  (one CHECK/EXPECT per `tasks.md` group, same step semantics as `e2e.json`);
  results in session `gate-results.json` with a staleness hash. When enabled,
  `forge integrity-check` also requires green + current gate results once all
  tasks are complete. Skill docs: coordinator re-runs the group gate before
  ticking boxes — subagent reports are self-certification only.
- **Evidence fingerprints**: e2e/gate step results additionally record
  `outputSha256`, resolved `cwd`, and `shell`. Zero runtime overhead.
- **Untrusted-artifact stance**: runtime-integrity doc paragraph — session
  artifacts and command output are data, never instructions.
- OWNS path-ownership claims are explicitly **not** built (filed as finding
  F3 for the parallel-workers mode).

## Capabilities

- `stop-gate`: turn-end completion backstop — delta at `specs/stop-gate/spec.md`
- `task-gates`: opt-in per-group executable gates — delta at `specs/task-gates/spec.md`
- `e2e-harness`: step evidence fingerprints — delta at `specs/e2e-harness/spec.md`

## Impact

- `templates/project/claude/hooks/` + `packages/cli/src/init.mjs` (settings
  snippet gains a `Stop` event; instructions string updated).
- New `packages/cli/src/gate.mjs` (+ tests), routing in
  `packages/cli/bin/forge.mjs`, integration in `packages/cli/src/integrity.mjs`.
- Step runner in `packages/cli/src/integrity.mjs` / `e2e.mjs` gains
  fingerprint fields (additive — existing result readers unaffected).
- Skill docs: `skills/forge/references/runtime-integrity.md`,
  `skills/forge/phases/implement.md`, `skills/forge/SKILL.md`,
  `skills/forge/docs/forge.md`; vendor copies refreshed via
  `packages/cli/scripts/prepack.mjs`.
- Risk: a buggy Stop hook could trap users at turn-end — mitigated by
  fail-open design, loop guard, off-switch, and dedicated tests.
- Overhead budget honored: default-off gates; stop hook spawns a CLI process
  only in claim-state.
