# Escape rate by pace, and an outside-plan flag for swept-in lines

## Why

Escape tracking (archived `escape-tracking`) reports the **Escape rate** per month only. The
maintainer's biggest worry is too much process, so the rate has to split by pace to show whether
standard-pace ceremony buys fewer Escapes than brisk.

Finding F16: single-session `forge checkpoint` stages with `git add -A`, so edits made concurrently in
the same tree land in a change's commits. Blame then credits those lines to the change, and later edits
to them surface as false **Escape candidates** — on main today, resource-leases ← 68780f2 (a roadmap
paragraph swept into dafaa0a).

## What Changes

- `forge escapes report` adds a BY PACE table, and `--json` adds `byPace: [{ pace, done, escaped, rate, open }]`.
  Pace = the one the session ran at when it reached done (digest `pace`, else the fleet entry's); none → `unknown`.
- Each Escape candidate carries `outsidePlan: string[]`, the hit files whose basename the change's own
  plan documents never mention. `forge escapes [list]` and the interactive prompt print
  `outside plan: <files> — possible sweep (F16)`. Label only: nothing is hidden or reordered.
- `forge checkpoint` is unchanged. F16 is handled on the detection side (see design.md).

## Capabilities

- `escape-tracking`: rate split by pace; outside-plan flag on candidates — delta at `specs/escape-tracking/spec.md`

## Impact

- `packages/cli/src/escapes.mjs` (`escapeReport`, `escapeCandidates`), `packages/cli/src/escapes-cli.mjs` (text output).
- New tests: `escapes-pace.test.mjs`, `escapes-outside-plan.test.mjs`; e2e `scripts/e2e/escape-tracking.mjs` extended.
- Docs: `skills/forge/docs/forge.md` CLI listing, `CHANGELOG.md` Unreleased.
- `--json` consumers get two added fields; no field removed or renamed.
