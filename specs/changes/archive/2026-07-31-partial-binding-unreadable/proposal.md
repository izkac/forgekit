# A partially readable host binding must not answer confidently

## Why

Finding F27. `reviewEvidence` guards only the case where *every* bound host
session is unresolvable. A session bound to two host sessions — ordinary, since
`bindHost` appends an id on resume — whose second session directory cannot be
read still answers `available: true` with `prescribed > 0` from the first.

A reviewer that ran in the unreachable half is then absent from `units`.
`hostFinalReview` reaches the `bucket === undefined` branch — the one its own
comment calls "the one genuine negative in this function" — and returns `self`
on `host` grade. Prose is never consulted, because `prescribed > 0` said the
convention was in use. `forge phase done` refuses correct work at the money/auth
gate on a fact nobody measured.

This is worse than the three collapse sites already fixed in that module. Those
produced silent negatives; this produces a confident wrong positive.

The cause is one line of `findTranscripts` and, eleven lines above it, its twin:
both discard every `statSync` error into a silent absence, so "pruned" and
"could not look" are the same answer.

## What Changes

- `findTranscripts` distinguishes `ENOENT` from every other stat error, at both
  the transcript stat and the sidecar stat. `ENOENT` keeps today's silent drop;
  anything else becomes a reported fact.
- `subagents` present but not a directory joins the reported facts rather than
  reading as absent.
- `findTranscripts` returns `{ found, unreadable }`. Elements of `found` keep
  their current shape.
- `reviewEvidence` reports `available: false` when any bound host session is
  unreadable, falling back to prose — the side that cannot refuse correct work.
- `collectMetrics` records unreadable ids in the metrics document instead of
  reporting a partial harvest as a total.

## Capabilities

- `review-evidence`: a binding that cannot be read in full cannot decide the
  gate (delta: `specs/review-evidence/spec.md`)
- `session-metrics`: a partial harvest is reported as partial (delta:
  `specs/session-metrics/spec.md`)

## Impact

- `packages/cli/src/metrics/host.mjs` — `findTranscripts` return shape and the
  two stat sites
- `packages/cli/src/metrics/review-evidence.mjs` — the new guard; the
  `KNOWN HOLE` comment is replaced by a note recording what the split bought and
  what it left
- `packages/cli/src/metrics/collect.mjs` — one destructure, plus the partial note
- `packages/cli/src/metrics/host.test.mjs` — five `deepEqual`s against the bare
  array shape
- `packages/cli/src/set-phase.mjs` — **added mid-change**, found by task 1.3's
  review: two comments at the gate assert F27 is unfixed, and one of them becomes
  untrue here. Comments only, no behavior

**Not fixed here, deliberately:** a *pruned* older transcript still yields a
confident answer from the surviving half. Making that unavailable is the
half-fix the code comment already rejected, at a measured cost of frequent
unavailability on every resumed session. It stays a named limit in the code.
Its real fix is F12's dispatch-time stamp, which survives pruning.

**Risk:** `findTranscripts` changes shape. Both consumers are in-repo and both
change in this proposal; there are no external callers.
