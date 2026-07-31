# Design — cursor-fleet-sandbox-register

## Context

`registerSession` already warns on failure but does not recover. Cursor’s agent
Shell tool sets `CURSOR_SANDBOX=native` and denies writes under
`~/.forgekit/`. Session files under `.forge/sessions/` still save.

## Decisions

### Pending stamp + flush

When `registerSession` fails to write the registry entry with `EACCES` or
`EPERM` (also match messages containing “Permission denied”), write:

```text
<project>/.forge/sessions/<sessionId>/fleet-pending.json
```

Contents: `{ "sessionId", "reason", "at", "engine?" }` — enough to retry.

`forge reminder` (all formats) after `touchSession`: if the active session has
`fleet-pending.json`, call `registerSession` again; on success delete the stamp.
Also scan sibling session dirs under `.forge/sessions/` for pending stamps and
flush those that succeed (covers done sessions that never registered).

### `forge fleet sync`

New subcommand: load every `session.json` under cwd’s `.forge/sessions/`, call
`registerSession` for each, report registered / failed / pending counts. Clears
pending on success.

### Actionable warning

Stderr MUST mention Cursor sandbox and that the agent should re-run forge with
unrestricted permissions (`required_permissions: ["all"]` in Cursor Shell), and
that `forge fleet sync` can recover later.

### Cursor host bind

`detectHost`:

1. Non-empty `CLAUDE_CODE_SESSION_ID` → `{ agent: 'claude-code', sessionId }`
2. Else non-empty `CURSOR_CONVERSATION_ID` or `CURSOR_TRACE_ID` →
   `{ agent: 'cursor', sessionId }` (prefer conversation id)
3. Else `{ agent: 'unknown', sessionId: null }`

`bindHost` / `new-session`: when Cursor conversation id is present and
`cursorChatId` is null, set `cursorChatId` to that id.

Claude continues to win when both envs are set (unusual).

### Cursor hooks init

`ensureCursorHookHints` (rename behaviour, keep export or add
`ensureCursorHooks`):

- Always write/update the snippet (docs).
- Create `.cursor/hooks.json` if missing with `version: 1` and sessionStart.
- If present, merge: ensure a sessionStart entry whose command contains
  `forge-session-start` exists; do not remove other hooks.

### Skill / docs

Add a short “Cursor sandbox” note to `skills/forge/SKILL.md` and
`docs/usage.md` / fleet troubleshooting: every `forge` invocation that creates
or updates a session must request unrestricted shell under Cursor.

## Alternatives considered

- **Docs only** — rejected; agents forget; sessions stay invisible.
- **Move registry into project** — rejected; breaks cross-project fleet.

## Risks

- Reminder hooks may themselves be sandboxed → pending remains until unsandboxed
  sync or terminal run. Mitigated by skill guidance + sync command.
- Hook merge mistakes — covered by init tests with pre-existing hooks.json.
