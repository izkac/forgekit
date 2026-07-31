# Delta for session-metrics

## MODIFIED Requirements

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
