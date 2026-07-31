# Cursor fleet sandbox registration

## Why

Cursor agent shells sandbox writes to the workspace only. Forge mirrors every
session into `~/.forgekit/fleet/sessions/` on `saveSession`. That path is outside
the project, so registration fails under landlock and Cursor sessions never
appear in `forge fleet` — while Claude and Kimi register fine. Operators then
cannot see or command Cursor work from the control terminal.

The same Cursor path also leaves `.cursor/hooks.json` unwired (init only drops a
snippet) and never binds a host session id (`detectHost` only knows Claude).

## What Changes

- On fleet register failure (`EACCES`/`EPERM`), write a project-local
  `fleet-pending.json` and emit an actionable sandbox warning.
- Flush pending registrations from `forge reminder` (sessionStart / per-turn)
  when the registry is writable.
- Add `forge fleet sync` to re-register all sessions under the current project.
- Bind Cursor hosts via `CURSOR_CONVERSATION_ID` / `CURSOR_TRACE_ID` (+ agent
  marker); set `cursorChatId` when the conversation id is available.
- `forge init --cursor` creates or merges `.cursor/hooks.json` (keep snippet).
- Document in the Forge skill and usage docs that Cursor agents must run forge
  CLI session writes unsandboxed (`required_permissions: ["all"]`).

## Capabilities

- `fleet-registry`: pending stamp, flush, sync, louder sandbox failure, Cursor
  hooks wiring via init.
- `session-metrics`: Cursor host binding alongside Claude.

## Impact

**Code** — `packages/cli/src/lib/fleet.mjs`, `fleet.mjs`, `session-reminder.mjs`,
`metrics/host.mjs`, `new-session.mjs` / `set-phase.mjs` (bindHost already called),
`init.mjs`, skill docs under `skills/forge/`, `docs/usage.md`.

**Data** — additive `fleet-pending.json` in session dirs; existing registry
entries unchanged.

**Risks** — hooks that also run sandboxed cannot flush; unsandbox skill guidance
remains mandatory. Merging hooks.json must not erase unrelated Cursor hooks.

**Out of scope** — relocating fleet into projects; Cursor transcript metrics
harvest; changing Cursor sandbox behaviour.

## Decision record

No ADR — non-architectural change (ADR disabled in this project; recovery wiring for Cursor sandbox).
