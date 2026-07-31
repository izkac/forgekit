# Delta for session-metrics

## ADDED Requirements

### Requirement: Cursor host sessions bind from Cursor environment ids
When `CLAUDE_CODE_SESSION_ID` is absent and a non-empty Cursor conversation or
trace id is present in the environment, host binding SHALL record
`host.agent` as `cursor` and SHALL append that id to `host.sessionIds`.
Preference order for the id: `CURSOR_CONVERSATION_ID`, then `CURSOR_TRACE_ID`.
When a Cursor conversation id is present and `cursorChatId` is unset, the
system SHALL set `cursorChatId` to that conversation id.

Claude’s session id, when present, SHALL continue to win over Cursor ids.

#### Scenario: Cursor conversation id alone

- **GIVEN** an environment with `CURSOR_CONVERSATION_ID` set and no Claude session id
- **WHEN** host binding runs on `forge new` or `forge phase`
- **THEN** `host.agent` is `cursor`
- **AND** that conversation id is in `host.sessionIds`
- **AND** `cursorChatId` equals the conversation id when it was previously null

#### Scenario: Claude id wins over Cursor

- **GIVEN** both `CLAUDE_CODE_SESSION_ID` and `CURSOR_CONVERSATION_ID` are set
- **WHEN** host binding runs
- **THEN** `host.agent` is `claude-code`
- **AND** only the Claude session id is appended for that bind

#### Scenario: No host ids

- **GIVEN** neither Claude nor Cursor session ids are set
- **WHEN** host binding runs on a fresh session
- **THEN** `host.agent` is `unknown`
- **AND** `host.sessionIds` is empty
