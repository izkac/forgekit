# Forgekit

Portable agent-skills monorepo. One package (`@forgekit/cli`), three bins:

| Bin | Role |
|-----|------|
| **`forgekit`** | Meta: install / list skills × agents |
| **`forge`** | Forge workflow sessions |
| **`review`** | Thorough code review pipeline |

## Quick start

```bash
npm install
npm link --workspace=@forgekit/cli    # forgekit + forge + review on PATH

# Pick skills and agents (interactive on TTY)
forgekit install
# or non-interactive:
forgekit install --skills forge,thorough-code-review --agents cursor,claude --force
forgekit list

# Day-to-day
forge new my-feature
review new my-branch --type branch

# Forge project wiring
cd /path/to/your-project
forge init --cursor --claude
```

Aliases (single-skill shortcuts):

```bash
forge install --cursor      # → forgekit install --skills forge --cursor
review install --all        # → forgekit install --skills thorough-code-review --all-agents
```

Requires Node 20+. OpenSpec CLI is optional but recommended for Forge (`forge doctor --install`).

## Layout

```
forgekit/
  skills/forge/
  skills/thorough-code-review/
  packages/cli/                 # @forgekit/cli → forgekit + forge + review
  templates/project/            # forge init
  docs/forge.md
  docs/thorough-code-review.md
```

## forgekit (install)

| Command | Purpose |
|---------|---------|
| `forgekit install` | Interactive: which skills + which agents |
| `forgekit install --skills a,b --agents cursor,claude` | Non-interactive |
| `forgekit install --all-skills --all-agents --force` | Everything |
| `forgekit list` | Installed vs missing for every skill × agent |

## Forge CLI

| Command | Purpose |
|---------|---------|
| `forge new` / `status` / `phase` / `prefs` / `models` | Sessions |
| `forge resolve-model` / `doctor` / `evidence` / `overlay` | Supporting |
| `forge init` | Project commands, rules, hooks |
| `forge install` | Alias → `forgekit install --skills forge` |

## Review CLI

| Command | Purpose |
|---------|---------|
| `review new` / `signals` / `carryforward` / `merge` / `render` / `export` | Pipeline |
| `review install` | Alias → `forgekit install --skills thorough-code-review` |

Thorough review does **not** auto-load — ask the agent explicitly. See `docs/thorough-code-review.md`.

## Developing Forgekit

```bash
npm test --workspace=@forgekit/cli
node packages/cli/bin/forgekit.mjs --help
```

After editing a skill, re-install with `forgekit install --force`.
