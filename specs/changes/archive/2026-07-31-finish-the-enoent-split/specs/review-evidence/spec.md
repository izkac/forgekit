# Delta for Review Evidence

## MODIFIED Requirements

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

#### Scenario: Every bound host session blocked, none absent

- **GIVEN** a session bound to one host session whose transcript cannot be
  examined — the directory holding it cannot be searched, so the id is reported
  unreadable and never found
- **WHEN** the census runs
- **THEN** host evidence is unavailable
- **AND** the reason names the blocked id and path
- **AND** the reason does not claim the transcript was pruned or written
  elsewhere
