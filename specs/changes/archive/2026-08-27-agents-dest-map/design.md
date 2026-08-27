# Design — dest map instead of a shared target

## Context

`agents-default-install` made `agents` the default picker entry. Users then
asked: skip naming a shared target; when they pick Cursor or Codex, write
`.agents` and dedupe. `gh skill install` already does this: several hosts share
`.agents/skills`, and a dest is written once.

## Decisions

### D1 — Destination is derived from the harness

Each `AGENTS` entry has `skillDir` as today. Cursor, Codex, Copilot, Gemini,
and OpenCode all resolve to `~/.agents/skills/<skill>`. Claude stays
`~/.claude/skills/<skill>`. Windsurf stays the vendor path (`.agents` support
not confirmed).

No `agents` key in `AGENTS`. `--shared` is not a flag; `parseArgs` throws a
targeted error naming `--cursor` / `--codex` (and friends). `--agents agents`
is an unknown agent id (existing unknown-agent path).

### D2 — Dedupe by dest, not by agent id

`installSkillsToAgents` groups `(skill, dest)` and copies once. Results may
still mention every requested agent id, but `status: 'installed'` is one
filesystem write per dest.

`reconcileInstall` / `uninstallSkillsFromAgents` remove a dest only when
**no remaining desired** (skill × agent) maps to it. Deselecting Cursor while
Codex remains must not delete `~/.agents/skills/forge`.

`listInstallStatus` reports unique dests, with the agent ids that map there.

`updateOutdatedSkills`: the `.agents` dest is foreign unless stamped (same
ownership rule as today’s `agentId !== 'agents'`), keyed by dest path, not by
a retired `agents` id.

### D3 — First-run picker

`defaultAgentSelection([])` returns the `.agents`-capable ids (cursor, codex,
copilot, gemini, opencode). Remembered/installed ids are unioned and deduped.
Claude is included only when already installed or in the remembered set.

### D4 — Retire stamped vendor leftovers

When a write lands on `~/.agents/skills/<skill>/`, delete a **stamped** copy
at that skill’s previous vendor path for each `.agents`-capable harness
(`~/.cursor/skills/<skill>`, `~/.codex/skills/<skill>`, `~/.copilot/skills/<skill>`,
`~/.gemini/skills/<skill>`, `~/.config/opencode/skills/<skill>`). Unstamped
dirs at those paths are foreign — leave them.

### D5 — Init

`initAgentIds()` can equal `AGENT_IDS` once `agents` is gone. Leftover
`'agents'` in user config stays filtered out of the init picker.

## Risks

- Cursor listing the skill twice until old `~/.cursor/skills/forge` is retired
  — D4 exists to prevent that on the next install/update.
- Users who passed `--agents agents` in scripts: targeted error, not a silent
  remap (so a typo does not install “for everyone”).
