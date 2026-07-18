# Forgekit

Portable agent-skills monorepo. One package (`@forgekit/cli`), three bins:

| Bin | Role |
|-----|------|
| **`forgekit`** | Meta: install / list skills × agents |
| **`forge`** | Forge workflow sessions |
| **`review`** | Thorough code review pipeline |

The **Forge** skill and several of its workflows are based on
[Superpowers](https://github.com/obra/superpowers) (MIT) — see [Attribution](#attribution).

## Quick start

```bash
npm install
npm link --workspace=@forgekit/cli    # forgekit + forge + review on PATH
# Once published: npm i -g @forgekit/cli

# Pick skills and agents (interactive on TTY)
forgekit install
# Asks: which skills, which agents, planning engine (OpenSpec vs built-in specs),
# whether to use ADRs, and ADR path (default docs/adr)

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
# If OpenSpec isn't set up, init offers to install + `openspec init`;
# decline (or --no-openspec) to use the built-in specs engine (specs/changes/)
```

Aliases (single-skill shortcuts):

```bash
forge install --cursor      # → forgekit install --skills forge --cursor
review install --all        # → forgekit install --skills thorough-code-review --all-agents
```

Requires Node 20+. OpenSpec CLI is optional — projects without it use the built-in specs engine (`forge doctor` reports readiness for whichever engine is configured).

## Layout

```
forgekit/
  skills/forge/
  skills/thorough-code-review/
  skills/archive-to-adr/
  skills/git-resolve-adr-conflict/
  packages/cli/                 # @forgekit/cli → forgekit + forge + review
  templates/project/            # forge init
  templates/adr/                # decisions.md, ADR index, hooks
  docs/forge.md
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
| `specs` (built-in) | `specs/changes/<name>/` | None — plain markdown, same layout |

`forgekit install` asks once and saves the default. `forge init` auto-detects:
existing `openspec/config.yaml` wins silently; otherwise it offers to install +
run `openspec init`, and declining scaffolds the specs engine. The engine lands
in `.forge/config.json` → `plan.engine`. Both engines share the change layout
(`proposal.md` / `design.md` / `tasks.md`, dated `changes/archive/`), so
archive→ADR and a later move to OpenSpec work unchanged.

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
| `forge init` | Project commands, rules, hooks; engine (`--openspec`/`--no-openspec`); optional `--adr` |
| `forge change new\|archive` | Specs-engine change scaffold / dated archive |
| `forge install` | Alias → `forgekit install --skills forge` |

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

```bash
npm test --workspace=@forgekit/cli
npm run lint
node packages/cli/bin/forgekit.mjs --help
```

After editing a skill, re-install with `forgekit install --force` (or `forgekit update`).
