# Delta for Session Metrics

## ADDED Requirements

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
