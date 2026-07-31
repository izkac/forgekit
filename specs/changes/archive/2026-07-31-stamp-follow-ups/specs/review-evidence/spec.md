# Delta for review-evidence

## MODIFIED Requirements

### Requirement: A review dispatch is stamped when its label is issued
`forge review-label` SHALL, after resolving the session and unit, write a
dispatch stamp into the session's own directory
(`reviews/dispatches.json`) recording the unit, the exact label, the
session id, the time, and the model resolved in-process at the reviewer's
tier. The stamp SHALL be appended, never overwritten. The write SHALL replace
the live file atomically (write a sibling temporary file in the same
directory, then rename onto `dispatches.json`) so a process killed mid-write
cannot leave a truncated live document that then refuses every later stamp.
Failure to write the stamp SHALL NOT block the label: the label is still
printed, the failure is reported on stderr, and stdout SHALL remain exactly
the label.

#### Scenario: Labelling the final reviewer writes the stamp

- **GIVEN** an open session and a writable session directory
- **WHEN** `forge review-label final` runs
- **THEN** stdout is exactly `forge-review final <session-id>`
- **AND** `reviews/dispatches.json` gains a stamp with unit `final`, that
  label, that session id, a timestamp, and the model resolved at tier
  `capable`

#### Scenario: A stamp that cannot be written does not block the dispatch

- **GIVEN** a session whose `reviews/` directory cannot be created
- **WHEN** `forge review-label final` runs
- **THEN** the label is still printed on stdout and the exit code is 0
- **AND** the failure is reported on stderr

#### Scenario: A killed mid-write cannot trap later stamps

- **GIVEN** a session whose live `reviews/dispatches.json` is already valid
- **WHEN** a stamp write is interrupted after the temporary sibling is
  written but before the rename completes
- **THEN** the live `dispatches.json` remains the previous valid document
- **AND** a subsequent stamp write succeeds and appends to that document

### Requirement: A binding that cannot be read in full cannot decide the gate
Where any host session bound to a Forge session cannot be read — its transcript
or its dispatch-record directory present and unreadable, as distinct from
absent — host evidence SHALL report itself unavailable, and the verdict SHALL
fall back to the prose reading.

A binding SHALL NOT be reported as readable because *some* of it was read. The
absence of a reviewer from a partially read binding is not evidence that no
reviewer ran.

**Unreadable SHALL be diagnosed before absent.** Where every bound host session
is unreadable, the unavailable reason SHALL name the ids and paths that could
not be read; the reason reserved for transcripts absent from disk ("pruned or
written elsewhere") SHALL be used only when nothing was blocked.

Where the dispatch-record directory stats as a directory but cannot be listed
(`readdir` fails), the unavailable reason SHALL name the host session id and
the directory path — the same identifying bar the un-stat-able and
not-a-directory shapes already meet.

#### Scenario: A reviewer that ran in the unreachable half

- **GIVEN** a session bound to two host sessions
- **AND** the first is fully readable and carries prescribed dispatches
- **AND** the second's session directory cannot be searched
- **AND** the final reviewer was dispatched in the second
- **WHEN** the census runs
- **THEN** host evidence is unavailable
- **AND** the verdict matches what the prose rule alone would return
- **AND** its evidence is `inferred`
- **AND** the final review is **not** reported as `self` on `host` grade

#### Scenario: A dispatch-record directory that is present and unreadable

- **GIVEN** a session whose bound host session has a `subagents` path that
  cannot be stat-ed, or that exists and is not a directory
- **WHEN** the census runs
- **THEN** host evidence is unavailable
- **AND** the reason names the host session id and the path

#### Scenario: A dispatch-record directory that cannot be listed

- **GIVEN** a session whose bound host session has a `subagents` directory
  that stats as a directory but cannot be read (`readdir` fails)
- **WHEN** the census runs
- **THEN** host evidence is unavailable
- **AND** the reason names the host session id and the directory path

#### Scenario: A transcript that was pruned, not blocked

- **GIVEN** a session bound to two host sessions
- **AND** the older transcript is absent from disk
- **AND** the newer is fully readable
- **WHEN** the census runs
- **THEN** host evidence is available and answers from the readable session
- **AND** the answer is unchanged from before this change

#### Scenario: Every bound host session blocked, none absent

- **GIVEN** a session bound to one host session whose transcript cannot be
  examined — the directory holding it cannot be searched, so the id is reported
  unreadable and never found
- **WHEN** the census runs
- **THEN** host evidence is unavailable
- **AND** the reason names the blocked id and path
- **AND** the reason does not claim the transcript was pruned or written
  elsewhere

## ADDED Requirements

### Requirement: A repeated bound host id is measured once
Where `host.sessionIds` lists the same non-empty id more than once, host
evidence SHALL treat it as one binding: the dispatch-record directory is
scanned once, and unit counts (`dispatched`, `seen`, `prescribed`) SHALL NOT
inflate from the repetition. A repeated id SHALL NOT be reported as a partial
binding.

#### Scenario: Duplicate id does not double-count the final unit

- **GIVEN** a session whose `host.sessionIds` is `[id, id]` for one readable
  host session that carries one final-unit dispatch
- **WHEN** host evidence is collected
- **THEN** host evidence is available and not partial
- **AND** `units.final.dispatched` is 1
