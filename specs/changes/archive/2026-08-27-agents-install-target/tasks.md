# Tasks

## 1. CLI: agents target (install + init + doctor)

- [x] 1.1 `install.mjs`: add `agents` to the `AGENTS` map
      (`~/.agents/skills/<skill>`). Tests: `AGENT_IDS` contains `agents`;
      `installSkillsToAgents(['forge'], ['agents'], { home })` writes the tree
      + stamp; `listInstallStatus`/`updateOutdatedSkills` cover the new pair.
- [x] 1.2 `init.mjs`: `--agents` flag; `initProject` copies the packaged forge
      skill to `.agents/skills/forge/` with stamp, refreshes on re-run,
      reports commands+hooks as skipped for this target; `'agents'` in
      `WIRED_AGENTS` and `wiredAgents` markers; not in `report.skillOnly`.
      Non-exclusive: `--agents --cursor` wires both roots. Tests in
      `init.test.mjs`.
- [x] 1.3 `doctor.mjs`: when `.agents/skills/forge` exists, warn (not fail)
      when outdated/unversioned vs the packaged skill; skip when absent.
      Tests in `doctor.test.mjs`.

## 2. Docs

- [x] 2.1 `skills/forge/docs/forge.md` agent-surfaces table + a short
      "Vendor-neutral `.agents` target" note (skills-only; no commands/hooks;
      invoke by name); `forge init --help` text already covered by 1.2.
- [x] 2.2 `docs/day-to-day.md` setup section + CHANGELOG entry (Unreleased).
