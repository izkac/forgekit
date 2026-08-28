# Design — unlazy-enforcement

## Context

Multi-capability change (3 capabilities, ~14 tasks) adopting enforcement
mechanisms from the unlazy skill under a strict no-overhead constraint.
Adopt the *mechanism* (machine-checked completion), not the *ceremony*
(approval stores, orchestration ledgers).

## D1 — Stop hook: block claims, not turns

The hook must never punish normal work. Order of checks, all fail-open:

1. Parse hook stdin JSON. `stop_hook_active: true` → exit 0 (Claude Code
   loop-protection contract: a block that led to a continued turn must not
   block again).
2. Fast path, plain `fs` only (no child process): read `.forge/active.json`;
   no session / unreadable → exit 0. Read `session.json`; phase in
   {triage, brainstorm, plan, done, skipped} → exit 0. Read
   `.forge/config.json`; `hooks.stopGate === "off"` → exit 0.
3. Claim-state test: phase in {verify, review, finish} OR
   (phase === implement AND tasksTotal > 0 AND tasksComplete >= tasksTotal).
   Not claim-state → exit 0. This is what keeps mid-implement turns free:
   an open checkbox means "not claiming done", so the hook stays silent.
4. Claim-state only: spawn `forge integrity-check` (~300ms). Exit 0 → allow.
   Non-zero → print `{"decision":"block","reason":"<problems + the commands
   to run>"}` and exit 0 (Stop hooks convey blocking via JSON, not exit code).
5. Any thrown error anywhere → exit 0. A broken hook must never trap the
   operator; enforcement is best-effort backstop, not a lock.

Rejected alternative: blocking whenever integrity is red regardless of task
state — punishes every mid-implement turn, violates the overhead constraint.

## D2 — Gates: reuse e2e step semantics, hard-gate on opt-in

- `gates.json` lives in the change dir next to `spine.json` / `e2e.json`:
  `{ "groups": [{ "id": "1", "title": "…", "check": "<cmd>",
  "expect": "<regex>", "timeoutMs": 60000 }] }`. A gate is met when exit 0
  AND expect matches combined output — identical to e2e steps, so the
  existing runner in `integrity.mjs` is reused, not duplicated.
- `forge gate init` scaffolds one entry per `tasks.md` `##` group (check
  empty, to be filled at plan time). `forge gate check [--group <id>]` runs
  and writes session `gate-results.json` with a `checksHash` (hash of the
  group's check+expect) so edited gates invalidate old evidence — same
  staleness model as `e2e-results.json`. `forge gate status` prints
  met/unmet/stale per group.
- **Opt-in wall**: unless `.forge/config.json → gates.enabled === true`,
  `forge gate` exits with a one-line "gates are not enabled" message and
  `runIntegrityChecks` ignores gates entirely. Zero cost for non-opted
  projects — the overhead constraint is met by default, not by care.
- Integrity: when enabled AND `gates.json` has groups with non-empty checks
  AND session tasksComplete >= tasksTotal, integrity requires green + current
  results for every group. Partial progress never gates.
- Gate authorship inherits runtime-integrity rule 3: a check that passes
  against a no-op handler is invalid evidence (reviewers police).

## D3 — Fingerprints

Step runner records `outputSha256` (hex of combined stdout+stderr),
resolved `cwd`, and `shell` per step, in both e2e and gate results.
Additive fields only; no reader changes required.

## D4 — Coordinator re-verify (docs-only mechanism)

`skills/forge/phases/implement.md`: when gates are enabled, the coordinator
runs `forge gate check --group N` after the implementer returns and before
ticking the group's boxes. Implementer self-reports are self-certification;
the mechanical check is the acceptance. (No new code — the CLI from D2 is
the mechanism.)

## Risks

- Stop hook JSON contract drift across Claude Code versions → covered by a
  test asserting the exact emitted shape; fail-open bounds the damage.
- Windows path/shell differences in the hook fast path → hook uses only
  `node:fs`/`node:path`; tests run on the repo's own Windows CI baseline.
- Blocking loop (hook blocks, agent can't fix, blocks again) → prevented by
  `stop_hook_active` guard.
