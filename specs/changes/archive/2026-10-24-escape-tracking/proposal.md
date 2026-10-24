# Escape tracking

## Why

Forgekit's Promise (CONTEXT.md) is that the **Escape rate** of done **Forge sessions** falls over
time. Nothing measures it: session scorecards grade process compliance, not outcomes, and the
session directory that knows which commits a change made is deleted by cleanup. Separately, the
2027-04-24 review cuts gates with zero **Gate fires** across the fleet — but no gate refusal is
recorded anywhere, so that review would have nothing to read.

## What Changes

- `forge phase done` records the change's **Commit range** (`baseCommit..HEAD`) on the session, in
  its `.forge/sessions.jsonl` digest row, and in its fleet registry entry.
- New `forge escapes`: for every done session (this project's ledger + fleet registry entries for
  this repo), lists **Escape candidates** — later commits within 14 days of done that modify or
  delete lines the change added, found by `git blame` on the later commit's parent. Same-session
  commits are skipped. Older rows without a range get one inferred from `forge(<slug>):` commits.
- The operator confirms or dismisses each candidate with one keystroke (TTY) or a flag
  (`forge escapes confirm|dismiss <session> <commit>`). Confirming requires a replay test path: the
  fix commit's test if it has one, otherwise one the operator names. Decisions persist in
  `.forge/escapes.jsonl` under the existing ledger lock.
- `forge escapes report` prints the Escape rate per month of done across the fleet.
- Every Forge gate refusal appends one line `{gate, sessionId, project, at}` to a machine-level
  `gate-fires.jsonl` next to the fleet registry. New `forge fires` lists fire counts per gate across
  the fleet, including known gates with zero fires.

## Capabilities

- `escape-tracking`: Escape candidates, decisions ledger, Escape rate report — delta at `specs/escape-tracking/spec.md`
- `gate-fires`: Gate fire log and report — delta at `specs/gate-fires/spec.md`
- `session-lifecycle`: Commit range recorded at done — delta at `specs/session-lifecycle/spec.md`

## Impact

- New: `packages/cli/src/escapes.mjs`, `escapes-cli.mjs`, `gate-fires.mjs`, `fires-cli.mjs`, their tests, `scripts/e2e/escape-tracking.mjs`.
- Small edits: `set-phase.mjs` (record range; log fires at refusals), `ledger.mjs` (digest field),
  `lib/fleet.mjs` (registry field), `bin/forge.mjs` (two commands), refusal sites in `guard-cli.mjs`,
  `enforce-model.mjs`, `integrity-check.mjs`, `record-evidence.mjs`, `tdd-run.mjs`,
  `review-label-cli.mjs`, `gate.mjs`, `checkpoint.mjs`; `scripts/run-tests.mjs` fleet dir.
- Lease files from `feat/resource-leases` are deliberately untouched; the lease guard hook gets its
  fire log after that branch merges.
- Out of scope: Escape replay eval tasks in `evals/harbor`.
