# Delta for Review Evidence

## ADDED Requirements

### Requirement: A binding that cannot be read in full cannot decide the gate

Where any host session bound to a Forge session cannot be read — its transcript
or its dispatch-record directory present and unreadable, as distinct from
absent — host evidence SHALL report itself unavailable, and the verdict SHALL
fall back to the prose reading.

A binding SHALL NOT be reported as readable because *some* of it was read. The
absence of a reviewer from a partially read binding is not evidence that no
reviewer ran.

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

#### Scenario: A transcript that was pruned, not blocked

- **GIVEN** a session bound to two host sessions
- **AND** the older transcript is absent from disk
- **AND** the newer is fully readable
- **WHEN** the census runs
- **THEN** host evidence is available and answers from the readable session
- **AND** the answer is unchanged from before this change

This last scenario is the known limit and is specified as such: a pruned half
still yields a confident answer. Making it unavailable would make every resumed
session unavailable once its older transcript expires. The reviewer that ran in
a pruned half remains invisible until a dispatch-time stamp is written into the
review artefact itself.

### Requirement: Locating a host transcript distinguishes absent from unreadable

The helper that locates transcripts and dispatch-record directories on disk
SHALL report ids it could not examine separately from ids it did not find.

An error of `ENOENT` SHALL be treated as absence, because a pruned transcript
and a session that dispatched nothing are ordinary conditions. Any other error
SHALL be reported.

An id found in one project directory SHALL NOT be reported as unreadable because
a different project directory could not be examined while searching for it.

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
