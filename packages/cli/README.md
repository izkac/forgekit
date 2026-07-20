# @izkac/forgekit

Portable agent skills + CLIs. One package, three bins:

| Bin | Role |
|-----|------|
| **`forgekit`** | Install / list / update / uninstall skills × agents |
| **`forge`** | Forge workflow sessions |
| **`review`** | Thorough code review pipeline |

## Install

```bash
npm i -g @izkac/forgekit
forgekit install
```

Interactive install uses arrow-key checkboxes — space to toggle, **`a` to select all**, enter to confirm. Pickers come pre-checked with what you already have installed; choosing the full set reconciles (new picks install, deselected ones are removed).

Supported environments: Claude Code, Cursor, Codex CLI, GitHub Copilot, Gemini CLI, Windsurf, opencode — each into its global Agent-Skills directory.

Non-interactive:

```bash
forgekit install --skills forge,thorough-code-review --agents cursor,claude,copilot --force
```

## Docs

- After install, full Forge reference: `~/.claude/skills/forge/docs/forge.md` (or the matching dir for your environment)
- [How to use Forgekit](https://github.com/izkac/forgekit/blob/main/docs/usage.md)
- [Repository README](https://github.com/izkac/forgekit#readme)

## License

MIT
