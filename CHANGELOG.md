# Changelog

## Unreleased

## 0.1.4 — 2026-07-20

- **More environments:** install targets now cover Claude Code, Cursor, Codex CLI, GitHub Copilot, Gemini CLI, Windsurf, and opencode — each into its global Agent-Skills (`SKILL.md`) directory. Shorthand flags `--copilot/--gemini/--windsurf/--opencode` added.
- **Select all:** the skills picker defaults to everything on a fresh machine; `a` toggles all in any checkbox.
- **Remembers installs & reconciles:** pickers pre-check what you already have; choosing the full set installs new skill×env pairs and removes deselected ones (`--prune` to force this non-interactively). Flag-scoped runs (e.g. `forge install`) stay additive.
- **ADR path only when relevant:** ADRs enable by picking an ADR skill; the ADR-directory question is skipped entirely when no ADR skill is selected (the standalone "use ADRs?" prompt is gone).

Note: `forge init` project wiring still targets Cursor / Claude Code / Codex — the three with command/rule/hook templates.

## 0.1.3 — 2026-07-20

- **Arrow-key selectors** (same UI as OpenSpec, via `@inquirer/prompts`): skill/environment pickers are checkbox multi-selects (space to toggle, `a` for all), yes/no questions are confirm prompts, the planning-engine choice is a two-option select, and the ADR directory input pre-fills its default. Numbered `1,3`-style menus removed. Ctrl+C exits cleanly (code 130). Non-interactive flags (`--skills`, `--agents`, `--all`) unchanged.

## 0.1.2 — 2026-07-19

- Interactive skill/agent picker: pick **one or more** (e.g. `1,3`) or all; clearer prompt and re-ask on bad input.
- Package README included so npm shows docs on the package page.
- **Forge reference ships with the skill:** `skills/forge/docs/forge.md` → installed as `~/.{cursor,claude,codex}/skills/forge/docs/forge.md`. Commands/rules point there (no missing monorepo `docs/forge.md`).

## 0.1.1 — 2026-07-19

- First installable npm release (`@izkac/forgekit@0.1.1`). `0.1.0` metadata was incomplete on the registry; republish fixed `npm i -g @izkac/forgekit`.
- CI: discover tests without Node 20 glob expansion; bump `actions/checkout` / `setup-node` to v5.

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
