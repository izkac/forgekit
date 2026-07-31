# Design

## Context

`readJsonl` (`packages/cli/src/metrics/transcript.mjs:65`) is the one function
that turns a transcript file into lines, and it has one way of saying no:

```js
try {
  raw = fs.readFileSync(filePath, 'utf8');
} catch {
  return []; // missing, unreadable, or a directory — advisory
}
```

Five call sites consume it: `transcript.mjs:509` (host version),
`review-evidence.mjs:313` (sidecar token counts), `collect.mjs:183` (host
version sniff), `collect.mjs:334` (parent transcript lines — **the totals**),
`collect.mjs:346` (sidecar lines — the totals again).

The prior change worked *around* the collapse rather than through it:
`collect.mjs` grew a second `readFileSync` per flagged id (`readSucceeded`)
whose only job is to learn what `readJsonl` refused to say. That probe is
scoped to flagged ids, so an unflagged id with a content-level read failure
still vanishes from the totals with zero trace — named by the round-2 reviewer
of that change's task 2.2 as the identical failure mode one level up, and filed
as F56.

F57 is one guard over: both consumers ask "did we find any transcripts at all?"
before "could we read what we found?", so a binding where every transcript is
blocked answers with the pruned-or-elsewhere message. Reproduced by the final
reviewer; `collect.mjs` additionally returns a degraded document with no
`unread` record on that path.

## Decisions

### 1. `{ lines, error }`, one function — no sibling, no throw

- Alternatives considered: a sibling `readJsonlChecked()` (zero churn); throwing
  on non-`ENOENT` (smallest signature change).
- Rationale: the sibling leaves the silent-collapse function in place as a trap
  for the next author — the same shape as the defect being fixed. Throwing turns
  an advisory helper into one that can crash `forge phase done`; every layer
  above is built fail-safe, and a helper that throws is the opposite direction.
  The chosen shape is the exact move `findTranscripts` made in the prior change,
  and it shipped clean with the same five-consumer discipline. User selected
  this option explicitly.

`error` is `null` on success — **a legitimately empty file is a successful read
of nothing** — else `{ code, message }` from the thrown error. Malformed lines
stay individually skipped exactly as today: a half-written line from a killed
process must not hide the rest, and that is line-level damage, not file-level
unreadability.

### 2. `ENOENT` populates `error`, deliberately unlike `host.mjs`

- Alternative considered: mirror `host.mjs`'s ENOENT-is-ordinary split, which is
  what F56's own text asks for ("the same way host.mjs now does").
- Rationale: the policy does not transfer across layers. `findTranscripts`
  *searches* — it probes every project directory for every id, so nearly every
  probe misses and absence is the routine outcome. `readJsonl` *reads a path
  that was located moments ago* — absence there is a race or a bug, never
  routine. Folding `ENOENT` into silence at the reading layer would rebuild the
  original defect for one error code. A caller genuinely wanting the searching
  policy writes `error?.code !== 'ENOENT'`; no current caller does. The
  divergence is stated in the function's JSDoc so it cannot read as an
  oversight.

### 3. Advisory callers write `.lines` — no compatibility export

- Alternative considered: keep a bare-array export for callers that do not care.
- Rationale: `readJsonl(p).lines` is six characters that record, at the call
  site, that the author considered the error and discarded it — which `[]`
  never recorded. A compatibility export re-creates the trap under a second
  name. The three advisory sites are version sniffs and sidecar token counts,
  where a failed read genuinely means "no data", already handled elsewhere.

### 4. `collect.mjs` deletes `readSucceeded`; `counted` derives from the real read

- Alternative considered: keep the probe alongside the new contract.
- Rationale: the probe exists only because `readJsonl` could not answer, and two
  reads of the same file can disagree (a race between them). Deriving `counted`
  from the error of the read that actually feeds the totals makes the claim and
  the fact the same event. Because the answer now arrives for every bound id at
  no extra cost, the unflagged-id silence closes as a side effect: a bound id
  whose transcript read fails joins `source.unread` with `counted: false` even
  when `findTranscripts` flagged nothing.

`doc.source.unread` keeps its `{ sessionId, counted }` shape. What changes is
coverage, not form.

### 5. F57 is a guard reorder, not a merged message

- Alternative considered: one combined guard with one message.
- Rationale: nothing-located and located-but-blocked remain distinct facts, and
  each existing message is correct for its own case — only the priority was
  wrong. In `review-evidence.mjs` the unreadable message was already reworded
  (prior change, task 4.4) to fit both transcript and sidecar entries, so it
  needs no text change. In `collect.mjs` the degraded reason must name the
  blocked ids.

### 6. A degraded document carries the blocked ids in `reason`, not in `unread`

- Alternative considered: add `unread` to degraded documents for shape
  consistency.
- Rationale: `unread`'s contract is "which of *these totals'* sources were
  unreadable"; a degraded document has no totals, so the field would qualify
  nothing. The reason string is the honest carrier on a no-totals document, and
  it is what an operator actually reads there.

## Risks / Trade-offs

- **`readJsonl` is on the `forge phase done` path.** A missed consumer receives
  an object where it expects an array; `for (const line of obj)` throws loudly
  rather than silently miscounting, which is the acceptable failure mode. All
  five consumers are named in the proposal and changed here.
- **Eight tests assert the bare-array shape** and are translated, not weakened:
  the missing-file case flips from asserting silence to asserting
  `error.code === 'ENOENT'`, which is strictly more.
- **Two reads become one** on the flagged-id path (the probe is deleted), so the
  performance direction is down, not up.
- **The empty-vs-failed distinction must survive the mechanism change.** The
  prior change pinned it with a genuinely-empty-transcript test asserting
  `counted: true`; that test must stay green untouched, and a mutation making
  empty read as failed must redden it.
