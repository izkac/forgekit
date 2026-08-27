# Opt-in Forge invocation

## Why

Forge currently auto-starts on every substantial-looking request: the skill self-invokes, always-on thin rules say “substantial work → Forge”, and Claude’s `UserPromptSubmit` triage hook nags on every prompt. Operators want Forge only when they ask for it.

## What Changes

- Start Forge only on `/forge` / `/forge:*` (except `/forge:skip`) or natural language “use Forge” / “using Forge” / “use the Forge …”.
- After that invoke, **triage remains Step 0** of the pipeline (substantial → continue; trivial/read-only → execute directly).
- Stop shipping and wiring `forge-triage-hook.mjs`. `forge init` and `forge doctor --install` unwire and delete leftovers on already-wired projects.
- Skill is no longer model-self-invoked (`disable-model-invocation: true`). Thin rules invert the default to direct execution.
- SessionStart reminders and the `/forge` (now also “use Forge”) prompt hook stay.
- An active session continues for follow-ups on that work without a second invoke.

## Capabilities

- `project-wiring`: retire the auto-triage hook; init/doctor strip leftover file and settings entries
- `session-lifecycle`: sessions start only on explicit invocation; triage is still the first step after invoke

## Impact

Agent surfaces (Cursor / Claude / Codex thin rules, Forge skill, slash-command copy, operator docs). Claude hook wiring. Existing projects keep auto-triaging until they re-run `forge init` or `forge doctor --install`, and reinstall the Forge skill (`forgekit install --skills forge --force`).
