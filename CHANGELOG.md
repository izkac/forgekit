# Changelog

## Unreleased

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
