# Brainstorm hardening: enforced Assumptions, durable-answer promotion, quality signals

## Why

The frontier-round brainstorm contract (Assumptions ledger, spec-churn-free
designs) is prose-only: nothing checks an agent actually wrote the ledger, the
answers users give die with the 14-day session scratch, and Forge measures
everything downstream of brainstorm but nothing about brainstorm itself. This
change adds the first mechanical backstop, a consent-gated way to make durable
answers permanent, and churn/ledger signals in the session ledger and
`forge analyze` — without touching scoring.

## What Changes

- **Plan gate:** `forge phase plan` refuses when the session's `phaseHistory`
  contains `brainstorm` but `.forge/sessions/<id>/brainstorm/notes.md` is
  missing or lacks an `## Assumptions` heading. New recorded waiver
  `--notes-waived "<reason>"` (`session.notesWaived`, surfaced in
  sessions.jsonl). Sessions that never entered brainstorm are exempt.
- **Quality signals:** `forge brief stamp` counts stamps on the session
  (`briefStamps`, and `briefRestampsAfterImplement` when implement already
  started — the spec-churn proxy). The sessions.jsonl digest row gains
  `brainstorm: { notes, assumptions, adrCandidates }` plus the stamp counters;
  `forge analyze` carries them per session and aggregates churn + mean
  assumptions. `forge score` is untouched.
- **Durable-answer promotion (docs):** the brainstorming skill's close now scans
  interview answers for permanent project truths and offers — with user
  consent — promotion to `CONTEXT.md`, `AGENTS.md`, or an `ADR-candidate:`
  entry; `phases/brainstorm.md` documents the new gate and waiver.
- **Product loop:** new `brainstorm-gate` e2e harness phase exercising refuse /
  pass / waiver paths against the shipped binary; the change's `e2e.json` runs
  it.

## Capabilities

- `session-lifecycle`: plan-transition gate — delta at
  `specs/session-lifecycle/spec.md`
- `session-analysis`: churn + ledger signals — delta at
  `specs/session-analysis/spec.md`
- `brainstorm-interview`: durable-answer promotion — delta at
  `specs/brainstorm-interview/spec.md`

## Impact

Code: `packages/cli/src/set-phase.mjs`, `brief-cli.mjs`, `ledger.mjs`,
`analyze.mjs`, their tests, and `scripts/e2e/harness-portability.mjs`. Docs:
`skills/forge/skills/brainstorming/SKILL.md`, `skills/forge/phases/brainstorm.md`.
Risk: the gate could block legitimate flows — mitigated by the phaseHistory
guard (apply/direct-plan sessions exempt) and the recorded waiver. sessions.jsonl
rows gain additive fields only; scorecards and grades are unchanged.
