# Spec: review evidence

## Purpose

Forge must be able to say who reviewed a change on evidence stronger than the
reviewed party's own account of itself, and must say plainly when it cannot
tell.

## Requirements

### Requirement: Authorship is measured from host evidence when it exists
Where the host recorded a subagent dispatch matching this session's review unit,
that record SHALL decide the verdict, and the review file's prose SHALL NOT be
consulted for it.

A dispatch record SHALL be matched to a Forge session by the session id carried
in its description, and by nothing else. A record naming a different session
SHALL NOT contribute to this session's verdict, and a record naming no session
SHALL contribute to no session's verdict.

#### Scenario: A dispatched reviewer whose report reads like a self-check

- **GIVEN** a session whose host sidecars include a reviewer dispatch for the final review
- **AND** the review file's prose contains the words `self-check`
- **WHEN** the census runs
- **THEN** the final review is `independent`
- **AND** its evidence is `host`

#### Scenario: A reviewer dispatched by a different session in the same conversation

- **GIVEN** two Forge sessions bound to one host session
- **AND** the only reviewer dispatch names the *other* session
- **AND** this session's review file declares it a self-check
- **WHEN** the census runs
- **THEN** the final review is `self`
- **AND** the neighbour's dispatch contributes nothing to this session's units

#### Scenario: A reviewer dispatch that names no session

- **GIVEN** a reviewer dispatch described in the older `forge-review <unit>` form
- **WHEN** the evidence is read
- **THEN** it is reported as unavailable
- **AND** the census falls back to the review file's prose

#### Scenario: A self-written review claiming to be dispatched

- **GIVEN** a session whose host sidecars include no reviewer dispatch for the final review
- **AND** the review file is headed `Reviewer: claude-opus-5 (final-reviewer)`
- **WHEN** the census runs
- **THEN** the final review is `self`
- **AND** its evidence is `host`

### Requirement: Absence of evidence never refuses work
Where host evidence is unavailable, the verdict SHALL fall back to the existing
prose reading, and SHALL NOT be reported as a self-check on the grounds of
absence alone.

#### Scenario: A host that writes no sidecars

- **GIVEN** a session bound to no host session, or whose transcript has been pruned
- **WHEN** the census runs
- **THEN** the verdict matches what the prose rule alone would return
- **AND** its evidence is `inferred`
- **AND** `forge phase done` behaves exactly as it did before this change

### Requirement: Adoption is detected, not assumed
Where the host recorded subagent dispatches for this session but **none** of them
carry the prescribed review label, the convention SHALL be treated as not in use
and the verdict SHALL fall back to the prose reading. A session SHALL NOT be
judged self-reviewed merely because its reviewer was dispatched with an
unprescribed description.

#### Scenario: A repo that has not adopted the convention

- **GIVEN** a session whose host sidecars contain dispatches, none of them prescribed
- **AND** a final review written by a genuinely dispatched reviewer
- **WHEN** the census runs
- **THEN** the verdict matches what the prose rule alone would return
- **AND** its evidence is `inferred`

#### Scenario: A repo that has adopted it

- **GIVEN** a session whose host sidecars contain at least one prescribed dispatch
- **AND** none of them is for the final review
- **WHEN** the census runs
- **THEN** the final review is `self`
- **AND** its evidence is `host`

#### Scenario: A session that dispatched nothing at all

- **GIVEN** a session whose host sidecars contain no dispatches at all
- **WHEN** the census runs
- **THEN** the final review is `self`
- **AND** its evidence is `host`

### Requirement: A dispatch must carry substance before it certifies a review
Where the host recorded a review dispatch for a unit, the record SHALL decide
that unit's verdict only when at least one dispatch the operator did not stop
did enough work to be a review. Below that floor the host SHALL report no
answer, and the verdict SHALL fall back to the review file's prose.

Substance SHALL be measured as the request count of a single dispatch, never as
the sum across dispatches: many token dispatches are not one review.

A dispatch stopped by the operator SHALL NOT contribute its substance to the
unit. Its own outcome is already decided by the operator's refusal.

Falling below the floor SHALL NOT by itself produce a verdict of `self`, and
SHALL NOT by itself refuse a transition. It routes the decision to the review
file's prose, which may then refuse on its own grounds.

These are requirements on the census's answer, in a single pass, and are not by
themselves end-to-end guarantees about `forge phase done`. Once a verdict has
been frozen, *A frozen verdict is replaced only by a pass that learnt
something* protects an `inferred` grade exactly when the deciding unit was on
record at the time it froze — a later pass that reads a manufactured host
negative no longer overwrites it. That protection does not reach a first freeze
whose own reading already found no unit on record: there is no earlier verdict
to fall back on, so nothing distinguishes a pruned record from one that never
existed. That gap is structural — it is F12's, not this requirement's — and is
not licence for this requirement to be read as covering it.

Where every dispatch for a unit was stopped, the operator's refusal SHALL decide
the unit and the floor SHALL NOT be consulted. Such a unit reports a busiest
dispatch of zero, which would otherwise fall below any floor and discard a
measurement the operator themselves produced.

#### Scenario: A token dispatch against a review file that admits no reviewer ran

- **GIVEN** a session whose only final-review dispatch made 1 request
- **AND** the review file's prose states no subagent read the change
- **WHEN** the census runs
- **THEN** the final review is `self`
- **AND** its evidence is `inferred`, not `host`

#### Scenario: A reviewer that genuinely ran

- **GIVEN** a session whose final-review dispatch made 55 requests
- **AND** the review file's prose reads like a self-check
- **WHEN** the census runs
- **THEN** the final review is `independent`
- **AND** its evidence is `host`

#### Scenario: Many token dispatches for one unit

- **GIVEN** a session with ten final-review dispatches, each of 1 request
- **WHEN** the census runs
- **THEN** the host reports no answer for that unit
- **AND** the verdict comes from the review file's prose

#### Scenario: A stopped dispatch beside a token one

- **GIVEN** a final-review dispatch of 60 requests that the operator stopped
- **AND** a second final-review dispatch of 1 request that ran to completion
- **WHEN** the census runs
- **THEN** the stopped dispatch's requests do not vouch for the second
- **AND** the host reports no answer for that unit

#### Scenario: A reviewer whose transcript was pruned

- **GIVEN** a final-review dispatch whose sidecar meta survives but whose
  transcript does not, so its request count reads 0
- **WHEN** the census runs
- **THEN** the host reports no answer for that unit
- **AND** the verdict comes from the review file's prose
- **AND** the census refuses nothing on account of the missing transcript

  (This pass records that the unit was on record, even though its transcript
  read empty. If the sidecar directory is later emptied as well, *A frozen
  verdict is replaced only by a pass that learnt something* is what keeps this
  verdict from being refused at that later pass — see below.)

### Requirement: The verdict outlives its evidence
The verdict and its evidence grade SHALL be written into the session and the
durable digest when collected. Once frozen, it SHALL NOT be recomputed from
evidence that may since have been pruned, except as *A frozen verdict is
replaced only by a pass that learnt something* licenses: a later pass that
itself learns something new about the final review — because the deciding
unit is still on record, changed or unchanged — may still replace it. A later
pass that finds no record where an earlier one did learns nothing, and SHALL
NOT replace it on that account alone.

#### Scenario: Transcript pruned after the session finished

- **GIVEN** a finished session whose verdict was `independent` with evidence `host`
- **WHEN** its host transcript is deleted and the digest is re-read
- **THEN** the recorded verdict and evidence are unchanged

### Requirement: A frozen verdict is replaced only by a pass that learnt something
Where a verdict has already been frozen for a session, a later pass SHALL
replace it only when that pass learnt something about the final review. A
pass that finds no record of the deciding review unit, where an earlier pass
found one, SHALL NOT replace the frozen verdict — the record was pruned
between the two, and its absence is not a finding about the review.

A pass that finds no record where no earlier pass found one either SHALL
replace the verdict normally. Nothing was dispatched, nothing has changed,
and the fresh reading is as good as the frozen one.

This protection SHALL apply only to a frozen verdict of `independent`. A frozen
`self` or `none` SHALL refresh freely: a stale negative may never strand a
session, and the asymmetry is deliberate — losing a measurement costs a grade,
keeping a stale one costs the work.

Whether the deciding unit was on record SHALL be recorded on the verdict when
it is frozen, and SHALL NOT be inferred later from the evidence grade. "The
record was pruned" and "nothing was ever dispatched" are identical in a
single reading; only the comparison between two passes separates them.

A verdict frozen before this fact was recorded SHALL remain valid and SHALL
keep the behaviour it had. Its absence SHALL NOT be read as "no unit was on
record".

#### Scenario: A reviewer that ran, whose record is pruned before the gate

- **GIVEN** a high-risk change whose review file's prose reads independent
- **AND** one unstopped final-review dispatch below the request floor, so the
  verdict freezes as `independent` on `inferred` evidence with the unit on
  record
- **WHEN** the dispatch record is pruned and the session is taken to `done`
- **THEN** the frozen verdict is kept
- **AND** the money/auth floor does not refuse the transition

#### Scenario: A review nobody ever dispatched

- **GIVEN** a high-risk change whose review file's prose reads independent
- **AND** no review dispatch on record in either pass, so the verdict freezes
  as `independent` on `inferred` evidence with no unit on record
- **WHEN** the host later reports that nothing was dispatched
- **THEN** the frozen verdict is replaced by the fresh reading
- **AND** the money/auth floor refuses the transition

#### Scenario: The record changed rather than vanished

- **GIVEN** a frozen verdict whose unit was on record
- **AND** a later pass that still finds the unit, now carrying the operator's
  stop
- **WHEN** the verdict is re-measured
- **THEN** the fresh reading replaces the frozen one

#### Scenario: A verdict frozen before the fact was recorded

- **GIVEN** a session whose frozen verdict carries no record of whether the
  unit was seen
- **WHEN** a later pass re-measures
- **THEN** the verdict is kept or replaced exactly as it would have been
  before this requirement existed
- **AND** the missing record is not read as "no unit was on record"

#### Scenario: A verdict carrying a non-boolean in that field

- **GIVEN** a session whose frozen verdict records something other than a
  boolean for whether the unit was seen
- **WHEN** the verdict is read
- **THEN** the whole verdict is rejected as not a measurement
- **AND** the caller falls back to a live census

### Requirement: A declined dispatch is reported, not assumed
Where the host records that an operator stopped a reviewer dispatch, the census
SHALL surface that fact and SHALL NOT treat it as either a completed review or
an automatic waiver.

#### Scenario: Operator declines the final reviewer

- **GIVEN** a sidecar for the final review carrying `stoppedByUser: true`
- **WHEN** the census runs
- **THEN** the final review is `self`
- **AND** the result records that a dispatch was stopped by the operator
- **AND** no waiver is applied on the session's behalf

### Requirement: Unit evidence reports the busiest single unstopped dispatch
Each unit's evidence SHALL carry the request count of its busiest dispatch among
those the operator did not stop, alongside the existing total across all
dispatches. A unit whose every dispatch was stopped SHALL report zero for the
busiest.

The floor itself SHALL NOT live with this measurement. Measurement and policy
are separate: the evidence collector reports counts, the census decides what
count is enough.

#### Scenario: Two dispatches, one stopped

- **GIVEN** a unit with a stopped dispatch of 60 requests and a completed
  dispatch of 20
- **WHEN** the evidence is read
- **THEN** the unit's total requests are 80
- **AND** the unit's busiest unstopped dispatch is 20

#### Scenario: Every dispatch stopped

- **GIVEN** a unit whose only two dispatches were both stopped
- **WHEN** the evidence is read
- **THEN** the unit's busiest unstopped dispatch is 0

#### Scenario: Evidence round-tripped through JSON without the new field

- **GIVEN** an evidence object built before this change, whose buckets carry no
  busiest-dispatch count
- **WHEN** the census reads it
- **THEN** the host reports no answer for that unit
- **AND** the verdict comes from the review file's prose

### Requirement: Evidence records counts, never content
Persisted review evidence SHALL contain identifiers, counts and timestamps only.
The dispatch `description` SHALL NOT be written, even though its format is
prescribed.

#### Scenario: Reviewer dispatched with a descriptive label

- **GIVEN** a reviewer sidecar whose `description` carries free-form text beyond the prescribed token
- **WHEN** evidence is collected and persisted
- **THEN** no part of the description text appears in any written artifact

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
