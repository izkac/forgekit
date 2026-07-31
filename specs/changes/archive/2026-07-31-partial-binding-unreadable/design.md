# Design

## Context

`findTranscripts` (`packages/cli/src/metrics/host.mjs:113`) answers "which files
on disk belong to these host session ids". It has one way of saying no, and it
uses it for two different facts:

```js
try { if (!fs.statSync(transcript).isFile()) continue } catch { continue }   // line 137-141
...
try { if (fs.statSync(sidecar).isDirectory()) sidecarDir = sidecar } catch {} // line 144-148
```

A pruned transcript and an unreadable one leave identical traces. So do a
session that dispatched no subagents and a session directory this process cannot
search.

`reviewEvidence` guards `sidecarDirs.length === 0` — every bound session
unresolvable. Two bound ids where one resolves is not that case, so the answer
is confident and half-blind.

### Why the repro is not the existing test

`review-evidence.test.mjs:710` chmods the `subagents/` directory to `000` and
asserts unavailable. That test passes today and is not this bug: `statSync` on a
`000` directory *succeeds*, because stat reads the parent's entry. It exercises
the `readdirSync` failure inside the scan, which was fixed in an earlier round.

F27's shape is `chmod 000` on `projects/<project>/<host-id>/`. The transcript is
`projects/<project>/<host-id>.jsonl` — a sibling *file*, still readable. The
sidecar is `projects/<project>/<host-id>/subagents` — *inside* the unsearchable
directory, so its stat throws `EACCES` and line 147 discards it.

## Decisions

### 1. Split `ENOENT` from every other error, rather than counting resolved ids

Rejected: `bound.length < sessionIds.length → unavailable`. The comment being
replaced already rejects it, and correctly — it makes every resumed session
unavailable once its older transcript expires, which is days.

The split dissolves that trade instead of paying it. Pruned (`ENOENT`) stays a
cheap silent drop. Unreadable (`EACCES`, `ELOOP`, `ENOTDIR` on a parent, fd
exhaustion) stops being invisible. The two were only ever conflated because
`catch {}` cannot tell them apart.

### 2. Both stat sites, not just the sidecar

F27 names the sidecar. The transcript stat eleven lines up has the identical
swallow and the identical consequence — a dropped id leaves the same partial
binding answering confidently. Fixing one and filing the other is scheduling a
duplicate finding.

### 3. Return `{ found, unreadable }`

The bare `Entry[]` can only describe ids that were *found*. With transcript-level
errors there is now a third thing to say, and no element shape can carry it.

Rejected: pseudo-entries with `transcript: null` appended to the array. They
break `for (const { transcript } of bound)` in `collect.mjs:296` silently —
`readJsonl(null)` — which is precisely the failure mode this change exists to
remove.

`found`'s element shape is unchanged, so each consumer changes by one
destructure. Both consumers are in this repo.

### 4. Found-elsewhere wins over a remembered error

`findTranscripts` scans every project directory for each id. An `EACCES` while
probing project A for an id that actually lives in project B says nothing about
that id. So a non-`ENOENT` error is remembered per id and only promoted to
`unreadable` if the id is found nowhere.

### 5. A sidecar failure yields a `found` entry *and* an `unreadable` id

The transcript's own lines are readable and still count for metrics. Dropping
the entry would trade this bug for a silent undercount. The id appears in both
lists and each caller decides which fact governs its answer: `reviewEvidence`
refuses to answer, `collectMetrics` collects and says what it missed.

### 6. `subagents` present but not a directory is unreadable

`statSync` succeeds, `isDirectory()` is false, and today `sidecarDir` stays
`null` — indistinguishable from a session that dispatched nothing. The module's
stated principle is that present-and-unreadable is not absent. One branch.

### 7. `collect.mjs` notes rather than degrades

Metrics are advisory; a partial harvest is worth having. Returning `degraded`
because one of two host sessions is unreadable throws away good data. The defect
to avoid is not partiality — it is a partial total reported as a total, which is
this same bug one context over, and which a reviewer already caught once as a
28.6% token undercount.

## Risks / Trade-offs

- **Shape change to a shared helper.** Mitigated by both consumers being in-repo
  and changed here, and by `found`'s elements being byte-identical to today's.
  `host.test.mjs` has five `deepEqual`s against the bare array that must move.
- **More unavailable answers than today.** By construction only for bindings
  that are genuinely unreadable, never for pruned ones — that is the whole point
  of the `ENOENT` split. Unavailable falls back to prose, which cannot refuse
  correct work, so the direction of any surprise is the safe one.
- **The pruned residual survives.** Named in the code deliberately, so the next
  reader does not mistake F27's resolution for covering it. F12's dispatch-time
  stamp is its fix.
- **`chmod` fixtures do not behave as root.** They follow the existing
  convention in `review-evidence.test.mjs:725`, including the
  `assert.throws(/EACCES/)` guard that fails loudly if the fixture is not
  genuinely unreadable rather than passing vacuously.
