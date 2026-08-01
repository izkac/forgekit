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

### Requirement: The stamp decides when the host cannot answer
Where host evidence cannot answer for the final unit — unavailable, or
carrying no well-formed record of that unit — a structurally valid stamp
for the final unit naming this session SHALL decide the verdict
`independent` with evidence `recorded`, and the review file's prose SHALL
NOT be consulted for it. Where host evidence can answer, it SHALL answer,
and the stamp SHALL NOT override it — with one exception: a negative
answer built on absence (the final unit missing from the record) that was
measured from a **partial binding** (one or more of the session's bound
host transcripts no longer on disk) is not a complete measurement, and a
valid stamp SHALL decide `independent` with evidence `recorded` over it.
A negative built on a measured record — every recorded dispatch of the
final unit stopped by the operator — SHALL stand regardless of stamps or
partial bindings, and a negative measured from a **complete** binding
SHALL stand: the host saw the whole conversation, and a label that was
printed but never carried by a dispatch is not a review. A stamp SHALL
NOT conjure a review: a session with no final review file remains `none`
regardless of stamps.

#### Scenario: A pruned transcript no longer erases the reviewer

- **GIVEN** a session whose final reviewer was labelled and stamped at
  dispatch time
- **AND** the host transcript has since been pruned from disk
- **AND** the review file's prose contains the words `self-check`
- **WHEN** the census runs
- **THEN** the final review is `independent`
- **AND** its evidence is `recorded`

#### Scenario: The host's answer outranks the stamp

- **GIVEN** a stamped final unit whose every host-recorded dispatch was
  stopped by the operator
- **WHEN** the census runs
- **THEN** the final review is `self` with evidence `host`
- **AND** `stoppedByOperator` is true

#### Scenario: A partial binding's confident negative does not erase a stamped reviewer

- **GIVEN** a session bound to two host sessions whose older transcript has
  been pruned from disk
- **AND** the surviving half's record carries no dispatch of the final unit
- **AND** a valid stamp for the final unit names this session
- **WHEN** the census runs
- **THEN** the final review is `independent` with evidence `recorded`

#### Scenario: A measured stop wins even over a partial binding

- **GIVEN** the same partial binding
- **AND** the surviving half records a final-unit dispatch whose every run
  was stopped by the operator
- **WHEN** the census runs
- **THEN** the final review is `self` with evidence `host`
- **AND** `stoppedByOperator` is true

#### Scenario: A complete binding's negative stands against the stamp

- **GIVEN** a session whose every bound host transcript is on disk
- **AND** the record carries no dispatch of the final unit
- **AND** a valid stamp for the final unit names this session
- **WHEN** the census runs
- **THEN** the final review is `self` with evidence `host` — the label was
  printed, but no dispatch ever carried it

#### Scenario: A stamp naming a different session credits nothing

- **GIVEN** a `dispatches.json` whose only stamp names another session's id
- **AND** no host evidence
- **WHEN** the census runs
- **THEN** the verdict falls back to the review file's prose, graded
  `inferred`

#### Scenario: A malformed stamp file is an absence, not an error

- **GIVEN** a `reviews/dispatches.json` that is not valid JSON
- **WHEN** the census runs
- **THEN** the census does not throw
- **AND** the verdict falls back to the review file's prose, graded
  `inferred`

### Requirement: The stamp substitutes for lost records, never for missing work
Where host evidence carries a well-formed record of the final unit whose
busiest unstopped dispatch is below the substance floor, the verdict SHALL
fall back to the review file's prose and the stamp SHALL NOT be consulted.

#### Scenario: A stamped token dispatch does not certify a review

- **GIVEN** a stamped final unit whose host record shows one unstopped
  dispatch of 1 request
- **WHEN** the census runs
- **THEN** the verdict is read from the review file's prose, graded
  `inferred`
- **AND** the stamp contributes nothing

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

### Requirement: Prescribed review coverage that never happened caps the grade
When a session's effective `review.perTask` setting prescribed per-group
reviewers and none were dispatched,
`forge score` SHALL cap the session's score. The cap SHALL be decided from the
review census directly — never from a variable that any code path leaves
unassigned — so that a session with no review artifacts at all is measured by
the same expression as a session with many.

An independent **final** review SHALL soften the cap but SHALL NOT remove it: it
answers whether an outside reader saw the finished whole, not whether the work
was reviewed as it was built.

#### Scenario: A session with no reviews of any kind is capped

- **GIVEN** a session at `thorough` or `standard` pace with at least 5 planned tasks
- **AND** its review census reports zero independent per-group reviews
- **AND** it has no independent final review
- **WHEN** `forge score` grades it
- **THEN** the score is capped at 69
- **AND** the cap is recorded in `caps` naming the missing review coverage

#### Scenario: An independent final review softens the cap to a B

- **GIVEN** a session at `thorough` or `standard` pace with at least 5 planned tasks
- **AND** its review census reports zero independent per-group reviews
- **AND** its final review is independent
- **WHEN** `forge score` grades it
- **THEN** the score is capped at 89
- **AND** the cap text distinguishes this from the no-reviewer-at-all case

#### Scenario: One dispatched reviewer lifts the cap

- **GIVEN** a session otherwise identical to the capped scenarios
- **AND** its review census reports at least one independent per-group review
- **WHEN** `forge score` grades it
- **THEN** no review-coverage cap is applied

#### Scenario: More review never scores worse than less

- **GIVEN** two sessions identical except that one has zero review artifacts and
  the other has one independent per-group review
- **WHEN** `forge score` grades both
- **THEN** the zero-review session's score is less than or equal to the other's

#### Scenario: A pace told to skip reviewers is not punished for obeying

- **GIVEN** a session at `brisk` or `lite` pace with zero independent per-group reviews
- **WHEN** `forge score` grades it
- **THEN** no review-coverage cap is applied

#### Scenario: A change too small to warrant a reviewer is not capped

- **GIVEN** a session at `standard` pace with fewer than 5 planned tasks
- **AND** zero independent per-group reviews
- **WHEN** `forge score` grades it
- **THEN** no review-coverage cap is applied

#### Scenario: The cap follows the frozen verdict, as the done gate does

- **GIVEN** a session whose frozen final-review verdict is `independent`
- **AND** whose review file prose alone would read as self-authored
- **WHEN** `forge score` grades it with zero independent per-group reviews
- **THEN** the cap applied is the 89 tier, matching the verdict the gate read

#### Scenario: A cap is noted only when it lowers the score

- **GIVEN** a session already scoring at or below the cap it qualifies for
- **WHEN** `forge score` grades it
- **THEN** the score is unchanged
- **AND** no applied-cap entry claims to have reduced it

### Requirement: Rejection census ignores instructional REJECT prose
`reviewCensus` SHALL increment `rejections` for a review file only when the
body contains a structural rejection marker — a `Round <n> … REJECTED` line
or a `**Verdict: REJECTED**` heading — not merely the token `REJECT` in
instructional text such as "REJECT if any of".

#### Scenario: REJECT-if instructions with APPROVED do not count

- GIVEN a group-review.md that contains `REJECT if any of:` and ends
  APPROVED with no Round REJECTED marker
- WHEN `reviewCensus` runs
- THEN that file does not increment `rejections`

#### Scenario: Real rejection round still counts

- GIVEN a group-review.md containing `## Round 1 — REJECTED`
- WHEN `reviewCensus` runs
- THEN `rejections` increments by at least 1 for that file

### Requirement: Live score/ledger census consults host evidence
When `forge score` or the session digest computes a live `reviewCensus`
because no frozen verdict exists on the session, it SHALL pass host
`reviewEvidence` into `reviewCensus` the same way `forge phase done` does.
A dispatch stamp alone SHALL NOT outrank a host-measured stop on that path.

#### Scenario: Live census sees a measured stop

- GIVEN a session with no frozen reviewVerdict
- AND a final dispatch stamp exists
- AND reviewEvidence reports a measured operator stop for final
- WHEN forge score runs
- THEN finalReviewEvidence is not graded `recorded` solely from the stamp
  in a way that ignores the stop

### Requirement: Published self-declaration phrases stay true in the census
The closed list of self-declaration phrases published in Forge's implement-phase
guidance SHALL each cause `reviewCensus` to grade a review as self-authored when
placed in the attribution region. A regression test SHALL extract those phrases
from the shipped markdown rather than hard-coding a parallel list.

#### Scenario: Each closed-list phrase grades self

- GIVEN the closed phrase list in `skills/forge/phases/implement.md`
- WHEN a review file's attribution region contains one listed phrase
- THEN reviewCensus grades that review as self-authored
