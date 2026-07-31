# Design

## Context

Follow-ups to `review-stamp-at-dispatch` and `finish-the-enoent-split`. The
stamp file and the host-binding locator are already shipped; these three fixes
close residual defects found by those changes' own reviewers.

Brainstorm:
`.forge/sessions/20260731T195528Z-stamp-follow-ups-366d01/brainstorm/`.

## Decisions

- **D1 — Deduplicate in `findTranscripts`.**
  Order-preserving unique of non-empty string ids at entry. Covers
  `reviewEvidence` and `collectMetrics` without rewriting durable `session.json`.
  Alternative rejected: caller-only dedupe (misses collect).

- **D2 — Temp file + `renameSync` for `writeStamp`.**
  Write `dispatches.json.tmp` in the same directory, then rename over the live
  file. On rename platforms this is atomic; a kill mid-write leaves the previous
  good file or an orphan `.tmp` that `readExistingForWrite` never opens.
  Refuse-on-malformed path unchanged. Alternative rejected: fsync-only (still
  truncates the live path).

- **D3 — Path in `scanSidecar` reason; host id at the call site.**
  `scanSidecar` does not know the host id; `reviewEvidence` does (via the
  bound entry). Match the existing unreadable message shape:
  `host session <id> (<path>): …`. Alternative rejected: folding readdir into
  `findTranscripts.unreadable` (larger redesign for a one-string fix).

## Risks / Trade-offs

- **Rename across filesystems** is not a concern: temp and live file share the
  `reviews/` directory.
- **Orphan `.tmp` after a kill** is harmless; next successful write overwrites
  it. Do not treat leftover `.tmp` as evidence to merge.
- **Dedupe changes `found` length** for hand-edited duplicates only; the
  existing "repeat is not partial" test tightens from `>= 1` to exact counts.

## Migration

None. Resolve F60, F61, F62 on ship.
