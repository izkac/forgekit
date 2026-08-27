# Proposal: Vendor-neutral `.agents` install target

## Why

OpenSpec ships a tool-agnostic target (`openspec init --tools agents`) that
writes skills to `.agents/skills/` — the shared root read by Codex, Zed, and
other tools adopting the AGENTS.md / dotagents ecosystem. Forgekit today only
installs into per-tool roots (`~/.cursor/skills`, `~/.claude/skills`, …) and
wires projects per tool. Users working across tools want one shared copy, and
teams want repos that carry Forge for any compatible agent without per-tool
setup.

## What changes

1. **`forgekit install`** gains an `agents` environment: installs selected
   skills to `~/.agents/skills/<skill>/` (user-level shared root). Appears in
   the interactive picker, `--list`, `--update`, `--uninstall`, and prune
   reconciliation like any other environment — one `AGENTS` map entry.
2. **`forge init`** gains an `agents` target (`--agents` flag + picker entry):
   copies the vendored Forge skill to `<project>/.agents/skills/forge/` with
   the standard install stamp, so the repo itself carries the skill for tools
   that read the project `.agents` root. Re-running init refreshes it.
3. **Skills-only, by design** (mirrors OpenSpec's conclusion): no command
   files (no universal command adapter exists) and no hooks (hook wiring is
   host-specific). Init reports both as intentionally skipped. Invocation in
   agnostic tools is by name — the natural-language "use Forge" invoke.
4. **Non-exclusive**: selecting `agents` alongside cursor/claude/codex is
   supported and expected; each target writes its own root.
5. **`forge doctor`** reports the project `.agents/skills/forge` copy when
   present: ok when current, warn when outdated against the packaged skill.

## Non-goals

- No `AGENTS.md` editing (OpenSpec also avoids it; the skill description is
  the trigger surface).
- No `.agents/commands/` (adoption too thin; per-tool commands remain the
  full-featured path).
- No hook replacement mechanism: hooks stay per-host backstops; the CLI and
  skill instructions remain canonical. Codex-grade degraded mode is accepted.
- Only forgekit-owned directories are managed (`.agents/skills/forge/`, plus
  other selected forgekit skills user-level); everything else under `.agents/`
  is left alone.
