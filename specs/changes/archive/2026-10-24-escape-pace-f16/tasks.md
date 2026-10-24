# Tasks

Existing test files are guarded during implement — new tests go in new `*.test.mjs` files.

## 1. Rate by pace and outside-plan flag
- [x] 1.1 `packages/cli/src/escapes.mjs` `escapeReport`: keep each done session's pace (digest `pace`, else registry entry's, else `unknown`); return `byPace` ordered per design D1. `packages/cli/src/escapes-cli.mjs` `printReport`: PACE table under the month table. Tests in new `packages/cli/src/escapes-pace.test.mjs`: two projects' done rows (standard ×2 with one confirmed Escape, brisk, one without pace) → `byPace` counts, rates, order, `unknown` last; months and total unchanged; CLI text shows the PACE rows. Verify: `node --test packages/cli/src/escapes-pace.test.mjs`.
- [x] 1.2 `packages/cli/src/escapes.mjs` `escapeCandidates`: plan text from the range's plan-dir files read at head (design D2); each candidate gets `outsidePlan`. `escapes-cli.mjs` `printList` and the interactive prompt print `outside plan: <files> — possible sweep (F16)` when non-empty. Tests in new `packages/cli/src/escapes-outside-plan.test.mjs` on a scratch repo: plan names `src/a.js`, range also adds `notes.md` lines; later commits rewriting each → `notes.md` candidate flagged, `src/a.js` not; a range with no plan files flags nothing; text list prints the label. Verify: `node --test packages/cli/src/escapes-outside-plan.test.mjs`.

## 2. Docs and product loop
- [x] 2.1 `skills/forge/docs/forge.md` CLI listing (report by pace, outside-plan label), `CHANGELOG.md` Unreleased; `scripts/e2e/escape-tracking.mjs` asserts `byPace` in `forge escapes report --json` and `outsidePlan` on the listed candidate, still printing `ESCAPE TRACKING GREEN`. Verify: `forge e2e run`.
- [x] 2.2 Run `forge escapes --json` and `forge escapes report` against this repo's real history (main checkout); record in verify evidence that the resource-leases ← 68780f2 candidate carries `outsidePlan`, and the by-pace table.
