# Tasks

## 1. Dest map + install dedupe

- [x] 1.1 `packages/cli/src/install.mjs`: drop the `agents` entry from `AGENTS`.
      Point `cursor`, `codex`, `copilot`, `gemini`, `opencode` `skillDir` at
      `~/.agents/skills/<skill>`. Claude and Windsurf unchanged. Export a
      helper for “ids that share the .agents dest” if tests need it.
      `--shared` throws a targeted error naming `--cursor`/`--codex`.
      Tests: dest paths, `--shared` error, unknown `agents` id, Cursor+Codex
      install writes once to `.agents` (not `.cursor` / `.codex`).
- [x] 1.2 Dedupe `installSkillsToAgents` by dest; uninstall/reconcile delete a
      dest only when no remaining selected harness maps there. Retire stamped
      leftover vendor copies when writing to `.agents`. Tests: two harnesses
      one dest; uninstall cursor keeps dest if codex remains; stamped
      `~/.cursor/skills/forge` deleted on cursor install; unstamped vendor
      dir survives.

## 2. Picker, list, update, init fixtures

- [x] 2.1 `defaultAgentSelection([])` pre-checks the `.agents`-capable ids;
      remembered Claude stays. `listInstallStatus` unique dests with agent
      aliases. `updateOutdatedSkills` uses dest ownership (stamped `.agents`
      only). Help text: drop `--shared`. Tests in `install.test.mjs`.
- [x] 2.2 `init.mjs`: `initAgentIds` = `AGENT_IDS` (no `agents` filter needed
      except leftover `'agents'` in user config). Update `init.test.mjs` /
      `doctor.test.mjs` fixtures that called `installSkillsToAgents(...,
      ['agents'])` to use `['cursor']` (same dest when `home` is the fixture
      root).

## 3. E2E + docs

- [x] 3.1 Rework `agents-target` in `scripts/e2e/harness-portability.mjs`:
      `forgekit install --skills forge --cursor` (isolated home) lands
      `<home>/.agents/skills/forge` and does **not** create
      `<home>/.cursor/skills/forge`. Keep init `--agents` error + retirement
      loop. `e2e.json` still expects `AGENTS TARGET GREEN`.
- [x] 3.2 Docs: `skills/forge/SKILL.md` surfaces table, `skills/forge/docs/forge.md`,
      `docs/day-to-day.md`, `CHANGELOG.md` Unreleased — no shared picker
      target; Cursor/Codex/… install to `.agents`; Claude vendor path.
