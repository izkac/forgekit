# Forgekit

Portable agent-skills monorepo. One package (`@izkac/forgekit`), three bins:

| Bin | Role |
|-----|------|
| **`forgekit`** | Meta: install / list skills × agents |
| **`forge`** | Forge workflow sessions |
| **`review`** | Thorough code review pipeline |

**New here?** Read **[How to use Forgekit](docs/usage.md)** — install, project wiring,
slash commands, simple vs jobs/workers examples, integrity (spine / defer /
executed e2e product loop), and a cheat sheet.

The **Forge** skill and several of its workflows are based on
[Superpowers](https://github.com/obra/superpowers) (MIT) — see [Attribution](#attribution).

## Quick start

Preferred — install the published package (Node 20+):

```bash
npm i -g @izkac/forgekit

# Pick skills and environments (arrow-key checkboxes; `a` = all)
forgekit install
# Environments: Claude Code, Cursor, Codex, GitHub Copilot, Gemini, Windsurf, opencode.
# Pickers remember what you have installed; re-running reconciles the difference.
# Also asks the planning engine (OpenSpec vs built-in specs). ADRs turn on by
# picking an ADR skill (then it asks the ADR path, default docs/adr).

# or non-interactive:
forgekit install --skills forge,thorough-code-review --agents cursor,claude --force
forgekit install --skills forge --agents cursor --adr --adr-dir docs/adr --adr-project
forgekit list

# Day-to-day
forge new my-feature
review new my-branch --type branch

# Forge project wiring (+ planning engine + optional ADR scaffold)
cd /path/to/your-project
forge init --cursor --claude --adr
# If OpenSpec isn't set up, init offers to install + `openspec init`.
# Choosing OpenSpec always writes plan.engine=openspec (setup can wait).
# Use --no-openspec for the built-in specs engine (specs/changes/)
```

One-shot without a global install: `npx @izkac/forgekit install …` (same bins via `npx forge` / `npx review` after the package is on PATH, or keep the global install).

Aliases (single-skill shortcuts):

```bash
forge install --cursor      # → forgekit install --skills forge --cursor
review install --all        # → forgekit install --skills thorough-code-review --all-agents
```

OpenSpec CLI is optional — projects without it use the built-in specs engine (`forge doctor` reports readiness for whichever engine is configured).

## Layout

```
forgekit/
  skills/forge/
  skills/thorough-code-review/
  skills/archive-to-adr/
  skills/git-resolve-adr-conflict/
  packages/cli/                 # @izkac/forgekit → forgekit + forge + review
  templates/project/            # forge init
  templates/adr/                # decisions.md, ADR index, hooks
  docs/usage.md                 # how-to tutorial (start here)
  docs/forge.md                 # pointer → skill copy
  skills/forge/docs/forge.md    # full Forge reference (ships with skill)
  docs/thorough-code-review.md
```

## forgekit (install)

| Command | Purpose |
|---------|---------|
| `forgekit install` | Interactive: skills + agents + planning engine + optional ADRs |
| `forgekit install --skills a,b --agents cursor,claude` | Non-interactive |
| `forgekit install --openspec` / `--no-openspec` | Save planning-engine default (`~/.forgekit/config.json`) |
| `forgekit install --adr --adr-dir docs/adr` | Enable ADRs; install ADR skills; save `~/.forgekit/config.json` |
| `forgekit install --no-adr` | Disable ADRs preference |
| `forgekit install --adr --adr-project` | Also scaffold ADR docs into `--cwd` |
| `forgekit install --all-skills --all-agents --force` | Everything |
| `forgekit list` | Installed / missing / outdated for every skill × agent |
| `forgekit update` | Reinstall outdated skills |
| `forgekit uninstall --skills … --agents …` | Remove installed skill dirs |

### Planning engine (OpenSpec optional)

Forge always plans through a tracked change; the engine is per project:

| Engine | Location | Tooling |
|--------|----------|---------|
| `openspec` | `openspec/changes/<name>/` | OpenSpec CLI (`/opsx:*`) |
| `specs` (built-in) | `<plan.dir>/changes/<name>/` (default `specs/`) | Same OpenSpec layout — proposal / design / tasks / delta `specs/` |

`forgekit install` asks once and saves the default. `forge init` auto-detects:
existing `openspec/config.yaml` wins silently; otherwise it uses the install
default (or asks), and offers to install + run `openspec init` when OpenSpec
is chosen. Declining or failing that setup still records `plan.engine:
openspec` — use `--no-openspec` for the built-in specs engine (add
`--plan-dir openspec` to reuse an OpenSpec tree without moving files). The
engine lands in `.forge/config.json` → `plan.engine` (+ `plan.dir` for specs).
Both engines share the change layout (`proposal.md` / `design.md` / `tasks.md`
/ delta `specs/<cap>/spec.md`, dated `changes/archive/`), so archive→ADR and
switching engines work unchanged.

### ADRs (optional)

When enabled:

1. Installs **`archive-to-adr`** and **`git-resolve-adr-conflict`** skills.
2. Saves preference to `~/.forgekit/config.json` (`adr.enabled`, `adr.dir`).
3. On `forge init --adr` (or install with `--adr-project` in a repo): writes
   - `.forge/config.json` — project ADR settings (committed)
   - `{adr.dir}/README.md` — status index (default `docs/adr/`)
   - sibling `decisions.md` — process / template
   - `scripts/hooks/*` — archive reminder + pending-ADR backstop

Forge finish only runs archive→ADR when `adr.enabled` is true.

## Forge CLI

| Command | Purpose |
|---------|---------|
| `forge new` / `status` / `phase` / `prefs` / `models` | Sessions |
| `forge resolve-model` / `doctor` / `evidence` / `overlay` | Supporting |
| `forge spine` / `e2e` / `defer` / `integrity-check` / `score` | Runtime integrity (incl. executable E2E acceptance) + L2 session scorecard |
| `forge init` | Project commands, rules, hooks; engine (`--openspec`/`--no-openspec`); optional `--adr` |
| `forge change new\|archive` | Specs-engine change scaffold / dated archive |
| `forge install` | Alias → `forgekit install --skills forge` |

Full workflow (phases, pace, integrity): [`skills/forge/docs/forge.md`](skills/forge/docs/forge.md).  
Step-by-step with examples: [`docs/usage.md`](docs/usage.md).

## Review CLI

| Command | Purpose |
|---------|---------|
| `review new` / `signals` / `carryforward` / `merge` / `render` / `export` | Pipeline |
| `review install` | Alias → `forgekit install --skills thorough-code-review` |

Thorough review does **not** auto-load — ask the agent explicitly. See `docs/thorough-code-review.md`.

## Attribution

Forgekit’s **Forge** skill and several of its workflows are based on
[Superpowers](https://github.com/obra/superpowers) (MIT). The bundled copies under
`skills/forge/skills/` — brainstorming, TDD, subagent-driven development,
verification-before-completion, requesting-code-review, and systematic-debugging —
started as Superpowers skills and were adapted into a maintained fork (see
`skills/forge/skills/NOTICE.md`). Upstream Superpowers is **not** required at runtime;
edit the forks here and reinstall with `forgekit install --skills forge --force`.

Other pieces in this repo (OpenSpec/specs planning engines, ADR skills, thorough
code review, the CLI) are Forgekit-original or adapted from other project conventions.

## Developing Forgekit

From a clone (contributors):

```bash
npm install
npm link --workspace=@izkac/forgekit   # local bins on PATH
npm test --workspace=@izkac/forgekit
npm run lint
node packages/cli/bin/forgekit.mjs --help
```

After editing a skill, re-install with `forgekit install --force` (or `forgekit update`).
