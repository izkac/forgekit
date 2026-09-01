# Design — brainstorm hardening

## Context

`set-phase.mjs` runs refusal gates before persisting anything (`enforceBriefGate`
at ~473 is the model: guard on phase, check, record waiver or exit 1). Brief
stamping (`brief.mjs` / `brief-cli.mjs`) overwrites a single
`<!-- forge-brief-specs-hash -->` marker and records nothing. sessions.jsonl rows
are built in `ledger.mjs` `appendSessionDigest` (~237–322); `analyze.mjs`
`buildAnalysis` aggregates them; `forge analyze` renders via `formatAnalysis`.

## Decisions

1. **Gate shape** (`enforceBrainstormNotesGate`, called beside `enforceBriefGate`):
   - `phase !== 'plan'` → return; no `brainstorm` entry in
     `session.phaseHistory` → return (apply/direct-plan flows exempt).
   - Require `<sessionDir>/brainstorm/notes.md` matching `/^##\s+Assumptions\b/m`;
     otherwise stderr names the file, the missing piece, and the waiver, then
     exit 1 (nothing persisted — gates run before `saveSession`).
   - `--notes-waived "<reason>"` parsed like the other waivers, stored as
     `session.notesWaived`, added to the ledger row next to `archiveWaived`.
     Alternative considered: warn-only — rejected, a warning does not protect
     the contract and the waiver already provides the escape.
2. **Churn proxy**: count re-stamps, not git history. `brief-cli.mjs stamp`
   increments `session.briefStamps`; if `phaseHistory` contains `implement`,
   also `session.briefRestampsAfterImplement`; then `saveSession`. The brief
   hash already tracks spec edits, so a re-stamp after implement ≈ spec churn
   after approval.
3. **Ledger fields (additive)**: row gains `briefStamps`,
   `briefRestampsAfterImplement`, and `brainstorm: { notes: boolean,
   assumptions: number, adrCandidates: number }` — notes.md existence, count of
   `- ` bullets under `## Assumptions` (until the next `##`), count of
   `ADR-candidate:` occurrences in decisions.md. Parsing lives in ledger.mjs
   beside the row builder; sessionDir may be gone post-cleanup → fields default
   null/0 and the parser never throws.
4. **Analyze**: per-session rows carry the new fields; totals gain
   `specChurnSessions` (rows with `briefRestampsAfterImplement > 0`) and
   `meanAssumptions` (over rows where brainstorm.notes is true);
   `formatAnalysis` prints one summary line. No score.mjs changes.
5. **E2E**: harness phase `brainstorm-gate` (own scratch project, modeled on
   `archive-gate`): refuse missing notes → refuse missing heading → pass with
   heading → separate session exercising `--notes-waived` records the field.
   Prints `BRAINSTORM GATE GREEN`. `e2e.json` step runs it with that regex.

## Risks

- Older sessions resumed mid-flight after upgrade could hit the gate without
  notes: acceptable — the message says exactly what to write, and the waiver
  exists.
- `## Assumptions` heading regex is deliberately loose (any level-2 heading
  starting with "Assumptions").
