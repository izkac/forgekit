# @izkac/forgekit

**A disciplined development workflow for AI coding agents — portable across Claude Code, Cursor, Codex, Copilot, Gemini, Windsurf, and opencode.**

![npm](https://img.shields.io/npm/v/@izkac/forgekit) ![node](https://img.shields.io/node/v/@izkac/forgekit) ![license](https://img.shields.io/npm/l/@izkac/forgekit)

AI agents are fast but undisciplined: they claim success on stubs, skip verification, over-build, and quietly leave the human behind. Forgekit installs a **gated workflow** that holds an agent to the standards a senior engineer would — and gives you, the operator, the visibility and control to stay in charge of a whole fleet of them.

One package, three command-line tools:

| Bin | What it does |
|-----|--------------|
| **`forgekit`** | Install / update the Forge skills into any supported agent |
| **`forge`** | Run the Forge workflow — sessions, integrity gates, fleet control |
| **`review`** | Standalone multi-pass thorough code review |

## Why Forge (the workflow)

Forge moves every substantial change through explicit phases — **triage → brainstorm → plan → implement → verify → review → done** — and enforces them with **executable gates**, not honor-system promises:

- **Operator brief** — before any code is written, the agent produces a plain-language HTML explainer of what's about to be built (with diagrams). It opens in your browser and *gates implementation*: you approve what you actually understand, not a wall of spec markdown.
- **Runtime spine** — every change declares how each capability wires up: library → runtime owner → what it writes → the evidence it works. No orphaned code that's "done" but never called.
- **Executable product loop** — for jobs, workers, and pipelines the end-to-end acceptance is a *command that must exit green*, not a paragraph claiming it would.
- **Registered deferrals** — "wire it up later" is only allowed when tracked; the finish gate refuses unresolved ones.
- **Session scorecard** — every session leaves a graded, measurable trail (A–F).

The result: agents that can't fake completion, and a workflow you can trust to run with less babysitting.

## Fleet control — command every session from one terminal

Running agents across three IDEs and two terminals? `forge fleet` is a single control surface over all of them, across every project and engine:

```bash
forge fleet list       # every session: phase, task progress, engine, activity
forge fleet watch      # live-refreshing dashboard (active sessions only; --all shows everything)
forge fleet view <s>   # detail + live transcript tail (Claude Code)
forge fleet send <s> "pause and report"   # message any session; --all broadcasts
```

Sessions auto-register the moment they touch Forge — including ones running inside Claude Desktop or Cursor. You see where everything stands at a glance and steer any of them without switching windows.

## Portable — one workflow, every agent

The same skills and the same discipline, installed into each agent's native skills directory:

**Claude Code · Cursor · Codex CLI · GitHub Copilot · Gemini CLI · Windsurf · opencode**

Planning is engine-flexible too: use the **OpenSpec** CLI if you have it, or the **built-in specs engine** (plain markdown, same layout) if you don't. Optional **ADRs** archive each finished change into an Architecture Decision Record.

## Install

```bash
npm i -g @izkac/forgekit
forgekit install            # interactive: pick skills + agents (space toggles, `a` = all)
```

Non-interactive:

```bash
forgekit install --skills forge,thorough-code-review --agents claude,cursor --force
```

Then wire a project and start working:

```bash
cd your-project
forge init --claude --cursor      # slash commands, rules, hooks, .forge/

# in the agent chat:
/forge add a health endpoint that returns { ok: true }
```

The agent triages, brainstorms with you, plans a tracked change, writes the operator brief for your approval, then implements task-by-task with TDD and per-task review — refusing to call itself done until the gates are green.

## Docs

- **[How to use Forgekit](https://github.com/izkac/forgekit/blob/main/docs/usage.md)** — full tutorial: install, project wiring, worked examples, integrity gates, fleet, cheat sheet
- **[Full Forge reference](https://github.com/izkac/forgekit/blob/main/skills/forge/docs/forge.md)** — phases, pace matrix, integrity rules (also installed at `~/.claude/skills/forge/docs/forge.md`)
- **[Repository](https://github.com/izkac/forgekit#readme)**

## License

MIT. The Forge skill and several of its workflows are adapted from [Superpowers](https://github.com/obra/superpowers) (MIT).
