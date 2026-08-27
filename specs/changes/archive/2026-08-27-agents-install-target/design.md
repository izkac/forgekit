# Design

## User-level target (`forgekit install`)

One entry in the `AGENTS` map in `packages/cli/src/install.mjs`:

```js
agents: {
  label: 'Shared .agents (vendor-neutral)',
  skillDir: (home, skillId) => path.join(home, '.agents', 'skills', skillId),
},
```

Everything downstream (stamping, `skillInstallStatus`, `--list`, `--update`,
`--uninstall`, prune, both interactive pickers — install envs and init envs
share `AGENT_IDS`) iterates the map, so no other install-side code changes.
`--agents agents` works via the existing `--agents <ids>` flag; no new
shorthand flag on install (would collide with `--agents <ids>`).

## Project-level target (`forge init`)

- `parseArgs`: `--agents` pushes `'agents'` (init has no `--agents <ids>`
  flag, so no collision).
- `initProject`: when `'agents'` is selected, copy
  `resolveSkillSource('forge')` → `<cwd>/.agents/skills/forge/` using
  `copyDirRecursive` + `writeInstallStamp` (both exported from install.mjs).
  If the destination exists it is refreshed in place (forgekit-managed tree,
  same rule as command/rule templates). Report entry:
  `report.agentsSkill = { dest, status }` plus a printed note that commands
  and hooks are skipped for this target (no adapter / host-specific).
- `WIRED_AGENTS` gains `'agents'`; `wiredAgents(cwd)` marker:
  `.agents/skills/forge` (directory presence).
- `'agents'` must no longer land in `report.skillOnly`.

## Doctor

When `<cwd>/.agents/skills/forge` exists, `forge doctor` adds a check:
`skillInstallStatus('forge', dest)` — `present` → ok; `outdated`/`unversioned`
→ warn (not fail) with the refresh command (`forge init --agents`). Absent
dir → check skipped entirely (the target is optional).

## Naming and hygiene

- `.agents` plural (the singular `.agent` belongs to Antigravity).
- Only `.agents/skills/forge/` is written/refreshed project-level; nothing
  else under `.agents/` is read, listed, or removed. Uninstall story
  project-level: delete the directory by hand (documented), matching how
  other per-project wiring is removed today.
- The project copy is meant to be committed (team-shared), like OpenSpec's.

## Docs

- `skills/forge/docs/forge.md` agent-surfaces table: add the shared target
  row (skills-only, no commands/hooks, invoke by name).
- `docs/day-to-day.md`: one paragraph in setup about the vendor-neutral
  option and what it does/doesn't get you.
- CHANGELOG entry.
