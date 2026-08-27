# Tasks

## 1. Install: shared `.agents` as default

- [x] 1.1 `packages/cli/src/install.mjs`: move `agents` to the front of the
      `AGENTS` map; label notes Cursor/Codex read the shared root; add
      `--shared` shorthand (pushes `agents`) to `parseArgs` + help text.
      Tests in `packages/cli/src/install.test.mjs`: map order/first key,
      `--shared` parsing.
- [x] 1.2 `promptAgents` pre-checks `agents` even when nothing is installed
      (remembered/installed entries still pre-checked). Test the checked-set
      computation (extract a pure helper `defaultAgentSelection(installed)` so
      it is testable without a TTY).

## 2. Init: retire the project-level agents target

- [x] 2.1 `packages/cli/src/init.mjs`: `parseArgs` throws a targeted error for
      `--agents` (points to `forgekit install`); remove `agents` from
      `WIRED_AGENTS`, the `initProject` agents branch, `wiredAgents` markers,
      help text, and the non-TTY error message; init picker choices exclude
      `agents` (and `rememberedAgents` results are filtered against picker
      choices). Tests: `--agents` error message, picker choice list, no
      `.agents/` writes on `--all`.
- [x] 2.2 `initProject` retires a stamped `<project>/.agents/skills/forge/`
      copy: delete + `agentsSkillRetired` in the report + human-readable line
      in `main`. Unstamped copy and other `.agents/` content byte-identical.
      Tests: stamped removed, unstamped survives, foreign file survives.

## 3. Doctor: legacy project copy check

- [x] 3.1 `packages/cli/src/doctor.mjs` `checkAgentsSkill`: stamped copy →
      warning naming `forge init` retirement / manual deletion; unstamped →
      check skipped (null); absent → skipped (unchanged). Warn never fails.
      Update `packages/cli/src/doctor.test.mjs` accordingly.

## 4. E2E + docs

- [x] 4.1 Rework `agents-target` phase in
      `scripts/e2e/harness-portability.mjs`: user-level install to
      `<home>/.agents/skills/forge` (kept); `forge init --agents` exits
      non-zero with the guidance message; a planted stamped project copy
      warns in doctor, then is deleted by `forge init --cursor` while a
      foreign `.agents/agents.md` survives byte-identical. Update the header
      comment. Author `e2e.json` for this change to drive the phase.
- [x] 4.2 Docs: `skills/forge/SKILL.md` Agent-surfaces table (shared
      `~/.agents/skills/forge/` for Cursor+Codex; Claude vendor path),
      `skills/forge/docs/forge.md` (surfaces table + shared-.agents section),
      `docs/day-to-day.md` (vendor-neutral paragraph), install/init help
      texts already covered by 1.1/2.1.
