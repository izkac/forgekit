# Finish the ENOENT split

## Why

Findings F56 and F57, both filed during `partial-binding-unreadable` (archived
2026-07-31) by its own reviewers. That change taught `findTranscripts` to
distinguish a transcript it could not **locate** from one it could not
**examine**. Two instances of the same conflation survived at the boundaries its
specs did not reach:

**F56.** `readJsonl` collapses every read failure into an empty array. A
transcript that can be stat-ed but not read — reproduced with `chmod 000` on the
file itself, which leaves `isFile()` true — contributes silently zero lines to
metrics totals, indistinguishable from a legitimately empty file. `collect.mjs`
already carries the cost: a redundant second `readFileSync` per flagged id
(`readSucceeded`) that exists only because `readJsonl` cannot answer "did the
read succeed", and which covers flagged ids only — an *unflagged* id with a
content-level failure still loses its whole session from the totals with zero
trace.

**F57.** Both consumers check `bound.length === 0` before the `unreadable`
guard, so a binding where **every** transcript is blocked rather than absent
reports the pre-fix message: "pruned or written elsewhere". The answer
(unavailable/degraded) is right; the diagnosis is wrong, and `collect.mjs` drops
`source.unread` entirely on that path.

## What Changes

- `readJsonl` returns `{ lines, error }` — `error` null on success (an empty
  file is a successful read of nothing), else the thrown error's `code` and
  `message`. Malformed lines stay skipped; that is line-level damage, not
  file-level unreadability.
- Deliberately unlike `host.mjs`, `ENOENT` **does** populate `error`:
  `findTranscripts` searches, so absence is routine; `readJsonl` reads a file
  located moments ago, so absence is a race. The divergence is stated in code.
- Three advisory call sites opt out visibly as `readJsonl(p).lines`.
- `collect.mjs` deletes the `readSucceeded` probe; `counted` derives from the
  real read's `error`. Content-unreadable transcripts now join `source.unread`
  with `counted: false` **whether or not anything else flagged the id**.
- Guard order flipped in `reviewEvidence` and `collectMetrics`: unreadable is
  checked before empty-bound, so an all-blocked binding gets the unreadable
  message. A degraded document names blocked ids in its `reason` (not in
  `unread` — no totals, nothing for `counted` to qualify).

## Capabilities

- `session-metrics`: the record of unread ids now covers content-level failures,
  and a wholly-blocked binding degrades with the true reason (delta:
  `specs/session-metrics/spec.md`)
- `review-evidence`: an all-blocked binding reports itself unreadable, not
  pruned (delta: `specs/review-evidence/spec.md`)

## Impact

- `packages/cli/src/metrics/transcript.mjs` — `readJsonl` signature; 8 tests
  translated
- `packages/cli/src/metrics/collect.mjs` — probe deleted, `counted` re-derived,
  guard reorder; net deletion expected
- `packages/cli/src/metrics/review-evidence.mjs` — guard reorder plus one
  advisory `.lines`
- Call-site churn is the whole cost of decision 1 and is deliberate: five sites,
  each forced to state whether it cares about the error.

**Risk:** `readJsonl` is on the `forge phase done` path. The shape change is
mechanical but the failure mode of a missed consumer is an object where an array
is expected — `for (const line of obj)` throws. All five consumers are in-repo
and named above; the prior change's identical move (`findTranscripts`) shipped
clean with the same discipline.

**Not fixed here:** surfacing `source.unread` anywhere (no reader exists; the
spine says so honestly); F12 and the pruned residual it owns.
