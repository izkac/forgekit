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

Interactive install lets you pick **one or more** skills (comma-separated, e.g. `1,3`) or all. Same for agent environments.

Non-interactive:

```bash
forgekit install --skills forge,thorough-code-review --agents cursor,claude --force
```

## Docs

- After install, full Forge reference: `~/.cursor/skills/forge/docs/forge.md` (or `~/.claude/…` / `~/.codex/…`)
- [How to use Forgekit](https://github.com/izkac/forgekit/blob/main/docs/usage.md)
- [Repository README](https://github.com/izkac/forgekit#readme)

## License

MIT
