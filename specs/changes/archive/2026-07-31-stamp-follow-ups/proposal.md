# Stamp Follow Ups

## Why

Three defects left open by the reviewers of `review-stamp-at-dispatch` and
`finish-the-enoent-split` sit in the same metrics/stamp area and still threaten
honest measurement of the money/auth final-review path.

A killed `writeStamp` can leave truncated `reviews/dispatches.json`. Readers
degrade safely to prose, but the writer then refuses every later stamp for that
session until someone deletes the file by hand — stamping silently disabled
(F62). A duplicated `host.sessionIds` entry (unreachable via `bindHost`, but
reachable via hand-edit or merge) double-scans the sidecar and inflates
`units.final.dispatched` toward the substance floor in the flattering direction
(F61). And when `subagents/` stats fine but `readdir` fails, the unavailable
reason names neither host id nor path — the one blocked-sidecar diagnosis that
identifies nothing (F60).

## What Changes

- `writeStamp` writes via a sibling temp file and renames onto
  `reviews/dispatches.json` (atomic replace). Refuse-on-malformed /
  never-destroy-evidence behaviour is unchanged.
- `findTranscripts` dedupes `sessionIds` order-preserving before locating, so
  `reviewEvidence` and `collectMetrics` both stop double-counting a repeated id.
- `scanSidecar`'s readdir-blocked reason includes the directory path;
  `reviewEvidence` surfaces the owning host session id with that reason.
- Findings F60, F61, F62 are resolved when the change ships.

## Capabilities

- `review-evidence`: atomic stamp write; named readdir-blocked diagnosis;
  duplicate-id binding no longer double-counts dispatches
  (delta: `specs/review-evidence/spec.md`)
- `session-metrics`: `findTranscripts` treats a repeated id as one id
  (delta: `specs/session-metrics/spec.md`)

## Impact

- Code: `packages/cli/src/review-stamp.mjs`,
  `packages/cli/src/metrics/host.mjs`,
  `packages/cli/src/metrics/review-evidence.mjs`, and their tests.
- Risk: F61 touches the money/auth substance floor (counts must not inflate);
  F62 protects the stamp file the census grades `recorded` from. Thorough pace
  / independent final review required.
- Migration: none. Live `bindHost` sessions are already duplicate-free; existing
  good stamp files are rewritten only on the next successful append.
- Out of scope: F63 (live-census fallback grade), analyze-report findings
  F64–F71, F48 cleanup, F11/F13 detector redesign.
