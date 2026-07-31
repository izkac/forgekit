# Session Metrics Spec

## Purpose

Describe this capability.

## Requirements

### Requirement: A partial harvest is reported as partial
Where a session is bound to several host sessions and some of them cannot be
read, metrics collection SHALL harvest what it can and SHALL record which ids it
could not read.

The record SHALL let a reader tell the two cases below apart. A bare list of ids
does not: an id whose sidecar alone was blocked and an id missing from the
totals entirely look identical in it, and those are the difference between
"these totals are complete but under-detailed" and "these totals are missing a
session".

Collection SHALL NOT report a partial harvest as a total, and SHALL NOT discard
a readable half because the other half is unreadable.

**"What it can" is per file, not per session.** An id whose dispatch-record
directory is unreadable but whose transcript is not SHALL still contribute its
transcript's own lines to the totals. Discarding them would answer a silent
undercount with a larger one — the parent transcript is where most of a
session's requests live, and the sidecar loss is already named.

#### Scenario: One of two host sessions has an unreadable sidecar

- **GIVEN** a session bound to two host sessions
- **AND** the second's dispatch-record directory cannot be read
- **AND** the second's transcript can be
- **WHEN** metrics are collected
- **THEN** the totals include both transcripts' lines
- **AND** the document names the second id as unread
- **AND** it is not reported as degraded

#### Scenario: One of two host sessions is wholly unreadable

- **GIVEN** a session bound to two host sessions, the second's transcript
  unreadable so that nothing of it can be located
- **WHEN** metrics are collected
- **THEN** the document carries the totals harvested from the first alone
- **AND** it names the second id as unread
- **AND** it is not reported as degraded

#### Scenario: Every host session readable

- **GIVEN** a session whose bound host sessions are all readable
- **WHEN** metrics are collected
- **THEN** the document carries no unread ids
- **AND** its totals are unchanged from before this change

### Requirement: Reading a transcript distinguishes empty from unreadable
The helper that turns a transcript file into lines SHALL report a failed read
separately from a successful read of an empty file. Every failure SHALL be
reported, `ENOENT` included: unlike the locating layer — where absence is the
routine outcome of searching — the reading layer operates on a path that was
just located, so absence there is exceptional.

A malformed line within a readable file SHALL still be skipped individually; a
half-written line from a killed process is line-level damage, not file-level
unreadability.

#### Scenario: A file that cannot be read

- **GIVEN** a transcript path whose content cannot be read
- **WHEN** lines are read
- **THEN** the failure is reported with the underlying error's code
- **AND** no lines are returned

#### Scenario: A file that is genuinely empty

- **GIVEN** a readable transcript containing nothing
- **WHEN** lines are read
- **THEN** no failure is reported
- **AND** no lines are returned

#### Scenario: A corrupt line amid good ones

- **GIVEN** a readable transcript with a malformed line between valid lines
- **WHEN** lines are read
- **THEN** the valid lines are returned and no failure is reported

### Requirement: A content-unreadable transcript is recorded, flagged or not
Where a bound host session's transcript can be located but its content cannot be
read, metrics collection SHALL record that id as unread with `counted` false —
regardless of whether the locating layer flagged the id for any other reason.
The claim that a session was counted SHALL derive from the outcome of the read
that fed the totals, not from a separate probe of the same file.

#### Scenario: An unflagged id whose transcript content cannot be read

- **GIVEN** a session bound to two host sessions, both located cleanly
- **AND** the second's transcript file unreadable while its directory is not
- **WHEN** metrics are collected
- **THEN** the totals carry the first session alone
- **AND** the second id appears as unread with `counted` false
- **AND** the document is not degraded

#### Scenario: An empty transcript still counts

- **GIVEN** a session bound to two host sessions, the second's transcript
  readable and empty, the second's dispatch-record directory unreadable
- **WHEN** metrics are collected
- **THEN** the second id appears as unread with `counted` true

### Requirement: A wholly blocked binding degrades with the true reason
Where every bound host session is unreadable rather than absent — at either
block point — metrics collection SHALL degrade with a reason naming the blocked
ids and what blocked them, not a reason that claims absence. The degraded
document carries the blocked ids in its reason; it does NOT carry an unread
record, because it has no totals for `counted` to qualify.

The two block points are distinct and both are covered: an id can fail at the
**locating** layer (its transcript cannot be examined because the directory
holding it cannot be searched — it is never found at all), or at the **reading**
layer (found cleanly, content unreadable).

#### Scenario: Blocked at the locating layer

- **GIVEN** a session bound to one host session whose transcript cannot be
  examined — the directory holding it cannot be searched, so the id is reported
  unreadable and never found
- **WHEN** metrics are collected
- **THEN** the document is degraded
- **AND** its reason names the blocked id as unreadable
- **AND** its reason does not claim the transcript was pruned or written
  elsewhere

#### Scenario: Blocked at the reading layer

- **GIVEN** a session bound to one host session whose transcript is found
  cleanly but whose content cannot be read
- **WHEN** metrics are collected
- **THEN** the document is degraded
- **AND** its reason names the read failure, not merely that no readable lines
  were held

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

### Requirement: Locating a host transcript distinguishes absent from unreadable
The helper that locates transcripts and dispatch-record directories on disk
SHALL report ids it could not examine separately from ids it did not find.

An error of `ENOENT` SHALL be treated as absence, because a pruned transcript
and a session that dispatched nothing are ordinary conditions. Any other error
SHALL be reported.

An id found in one project directory SHALL NOT be reported as unreadable because
a different project directory could not be examined while searching for it.

A list of session ids that repeats the same non-empty id SHALL be treated as
one id: the helper SHALL locate it once and SHALL NOT emit duplicate `found`
entries for the repetition.

#### Scenario: An id absent from an unreadable project directory

- **GIVEN** two project directories, the first unsearchable
- **AND** the id's transcript in the second
- **WHEN** transcripts are located
- **THEN** the id is reported as found
- **AND** no id is reported as unreadable

#### Scenario: An id found nowhere, with one directory unsearchable

- **GIVEN** two project directories, the first unsearchable
- **AND** the id's transcript in neither
- **WHEN** transcripts are located
- **THEN** the id is reported as unreadable, not as absent

#### Scenario: A transcript that is simply not there

- **GIVEN** an id whose transcript is absent from every project directory
- **AND** every directory readable
- **WHEN** transcripts are located
- **THEN** the id is omitted, and is not reported as unreadable

#### Scenario: A repeated id is located once

- **GIVEN** an id whose transcript is on disk
- **WHEN** transcripts are located for `[id, id]`
- **THEN** `found` contains exactly one entry for that id
