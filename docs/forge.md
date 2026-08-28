# Forge — disciplined development workflow

The full Forge reference **ships with the Forge skill** so global npm installs always have it:

**[`skills/forge/docs/forge.md`](../skills/forge/docs/forge.md)**

After `forgekit install`:

| Agent | Path |
| ----- | ---- |
| Cursor / Codex / Copilot / Gemini / OpenCode | `~/.agents/skills/forge/docs/forge.md` |
| Claude Code | same files, via `~/.claude/skills/forge/` (symlink) |
| Windsurf | same files, via the Windsurf vendor skill symlink |

**Editing a skill doc (this file's target, `pace.md`, etc.)?** That edit lands
in this repo checkout only. Every machine that already ran `forgekit install`
keeps reading its installed copy at the paths above until it re-runs
`forgekit install --skills forge --force` — including your own machine, if
you installed before making the edit.

Tutorial: [`docs/usage.md`](usage.md).
