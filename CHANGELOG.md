# Changelog

## Unreleased

### Session scorecard (L2 measurement)

- **`forge score`**: grades session artifacts (spine, deferrals, product-loop quality, evidence, pace) → JSON/markdown; `--write` saves `scorecard.json` + `scorecard.md`.
- **`forge phase done|finish`**: always writes the scorecard and stamps `session.score` / `session.scoreGrade`. Incomplete finishes are capped at grade ≤ D (59).
- Docs: [usage.md](docs/usage.md) § Session success (L1 process / L2 score / L3 ship-check).

### Docs

- New tutorial: [`docs/usage.md`](docs/usage.md) — install, project wiring, slash commands, simple vs jobs/workers examples, integrity (spine / defer / product loop), cheat sheet.
- **Spine is mandatory** for every Forge change (filled rows or `notApplicable`). No longer inferred from slug/keywords — that miss let hollow platforms skip the matrix.

### Forge runtime integrity — round 2 (product-loop acceptance)

- **Spine matrix**: `forge spine init|check` — per-change `spine.json` mapping capability → library → runtime owner → writes → reads → UI consumer → evidence. Library-only rows fail validation.
- **Deferral registry**: `forge defer add|resolve|list` — "wiring later" must name a registered open task; unresolved deferrals block done. Reviewers reject unregistered deferrals.
- **`forge integrity-check`**: mechanical gate (spine validity, open deferrals, product-loop/BLOCKED evidence) — run automatically by `forge phase finish|done`.
- **E2E redefined as product loop**: producer→consumer→decision-changes-output; a single job slice or library E2E no longer counts. `verify-evidence.md` needs a `## Product loop` section (or explicit BLOCKED, which refuses done).
- **Job-kind closure**: every product-surface job kind wired end-to-end or deleted before complete; "fail closed" is only a temporary BLOCKED state.
- **Consumer–producer rule**: anything UI/API reads must be proven production-written.
- Prompts/phases updated: plan scaffolds the spine; task reviewer rejects unregistered deferrals and library-only spine rows; final reviewer requires product-loop evidence.

### Forge runtime integrity

- Always-on rules: `skills/forge/references/runtime-integrity.md` (no stubs / false success, runtime owner required, tests must fail on a no-op, specs beat narrow tasks, E2E-or-BLOCKED).
- Hardened implementer / task-reviewer / final-reviewer prompts; plan orchestration seam; verify wiring audit + E2E gate.
- Pace `auto` fails closed to **standard** for unrecognized scope; worker/job/queue/pipeline/etl/platform/orchestration/openspec signals → standard; explicit small-work → brisk.
- Task-count escalation: `--tasks-total ≥ 15` upgrades brisk/lite → standard when pace is not pinned.
- `forge phase finish|done` requires `verify-evidence.md` and all tasks complete (escape: `--allow-incomplete "<reason>"`).
- Defaults: `integrity.forbidStubs`, `specsBeatNarrowTasks`, `requireE2E`; session reminders inject integrity line.
- **Upgrade:** re-run `forgekit install --skills forge --force` on each machine to pick up skill changes.

## 0.1.0 — 2026-07-18

Initial public release of `@izkac/forgekit` (npm name; `@forgekit/cli` is taken by an unrelated project).

- Portable skills: Forge, thorough-code-review, archive-to-adr, git-resolve-adr-conflict
- Optional OpenSpec planning engine with built-in `specs/` fallback
- Optional ADR scaffolding (`docs/adr` by default)
- Selective `forgekit install` / `list` / `update` / `uninstall`
- `forge` session CLI + `review` thorough-review pipeline
- Published package vendors `skills/` + `templates/` via `prepack`
