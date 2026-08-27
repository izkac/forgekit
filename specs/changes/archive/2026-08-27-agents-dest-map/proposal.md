# Harness picker writes `.agents` for hosts that read it

## Why

The 0.3.48/0.3.49 “shared `.agents` target” is a location, not a product. Users
pick **Cursor** or **Codex**, not “shared environment”. Cursor, Codex, Copilot,
Gemini CLI, and OpenCode all discover `~/.agents/skills/` natively. Claude Code
does not. Exposing a separate shared target duplicates the choice and invites
double copies (`~/.cursor/skills` **and** `~/.agents/skills`).

## What Changes

- Remove the selectable `agents` environment and the `--shared` flag.
- Map Cursor, Codex, Copilot, Gemini, and OpenCode skill installs to
  `~/.agents/skills/<skill>/`. Claude and Windsurf keep their vendor paths.
- Deduplicate by destination: selecting several `.agents`-capable harnesses
  writes the skill once.
- Reconcile/uninstall delete a dest only when no remaining selected harness
  still maps there.
- Installing to `.agents` retires forgekit-stamped leftover copies at the old
  vendor paths for those harnesses (`~/.cursor/skills`, `~/.codex/skills`, …).
- First-run picker pre-checks the `.agents`-capable harnesses (one write
  covers them). Claude is not pre-checked unless already installed/remembered.
- Docs, list output, doctor fixtures, and the `agents-target` e2e phase follow.

## Capabilities

- `project-wiring`: dest map, dedupe, picker, retire old vendor copies —
  delta at `specs/project-wiring/spec.md`

## Impact

- `packages/cli/src/install.mjs` (+ tests), `init.mjs` (drop `agents` filter
  once the id is gone), `doctor.test.mjs` fixtures, e2e harness, docs.
- `forgekit install --agents agents` / `--shared` become errors with guidance
  to `--cursor` / `--codex` / ….
