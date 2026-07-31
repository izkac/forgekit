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
