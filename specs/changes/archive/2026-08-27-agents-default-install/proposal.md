# Shared `.agents` as the default install target; retire the project-level copy

## Why

Verified against current documentation: Cursor discovers skills natively from
`.agents/skills/` and `~/.agents/skills/` (alongside its own `.cursor/skills/`
paths), and Codex CLI treats `.agents/skills` as its *canonical* location
(`$CODEX_HOME/skills` is deprecated upstream). Only Claude Code still requires
its vendor path (`~/.claude/skills/`).

That inverts two decisions from `agents-install-target` (0.3.48):

- Installing per-tool copies for Cursor and Codex duplicates what one shared
  root already covers. The shared root should be the default, not an extra.
- The project-level `forge init --agents` copy of the skill duplicates a
  user-global concern into every repo, confuses users about where skills live,
  and has no consumer the shared user root doesn't already serve.

## What Changes

- `forgekit install`: the `agents` environment (shared `~/.agents/skills/`)
  becomes the default — first in the picker, pre-checked even on first run.
  Cursor/Codex stay selectable (their labels note they also read the shared
  root) but are no longer implied defaults. New `--shared` shorthand flag for
  parity with `--cursor`/`--claude`/….
- `forge init`: the `--agents` flag and the `agents` picker entry are removed.
  Passing `--agents` fails with guidance pointing to `forgekit install`.
  Init retires an existing **forgekit-stamped** `<project>/.agents/skills/forge`
  copy (deletes it, reports the retirement). Unstamped/foreign content under
  `.agents/` is never touched.
- `forge doctor`: the project-copy check flips from "stale copy → refresh with
  `forge init --agents`" to "stamped legacy copy → warn, name `forge init`
  (which retires it) or manual deletion". Unstamped directories are ignored
  (foreign). Absent directory: check skipped, as today.
- E2E harness `agents-target` phase reworked to the new contract.
- Docs: skill Agent-surfaces table, `docs/forge.md`, `docs/day-to-day.md`,
  CLI help texts.

## Capabilities

- `project-wiring`: install defaults, init retirement, doctor legacy check —
  delta at `specs/project-wiring/spec.md`

## Impact

- `packages/cli/src/install.mjs`, `init.mjs`, `doctor.mjs` + their tests
- `scripts/e2e/harness-portability.mjs` (`agents-target` phase)
- `skills/forge/SKILL.md`, `skills/forge/docs/forge.md`, `docs/day-to-day.md`
- Behavioral break for 0.3.48 users of `forge init --agents`: the flag now
  errors with guidance; stamped project copies are cleaned up by the next
  `forge init`. No data loss — the same skill lands in `~/.agents/skills/`.
