# Forge — disciplined development workflow

The full Forge reference **ships with the Forge skill** so global npm installs always have it:

**[`skills/forge/docs/forge.md`](../skills/forge/docs/forge.md)**

After `forgekit install`:

| Agent | Path |
| ----- | ---- |
| Cursor | `~/.cursor/skills/forge/docs/forge.md` |
| Claude Code | `~/.claude/skills/forge/docs/forge.md` |
| Codex CLI | `~/.codex/skills/forge/docs/forge.md` |

**Editing a skill doc (this file's target, `pace.md`, etc.)?** That edit lands
in this repo checkout only. Every machine that already ran `forgekit install`
keeps reading its installed copy at the paths above until it re-runs
`forgekit install --skills forge --force` — including your own machine, if
you installed before making the edit.

Tutorial: [`docs/usage.md`](usage.md).
