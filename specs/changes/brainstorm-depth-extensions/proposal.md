# Brainstorm depth extensions (spike, questionnaire, red-team, domain pass)

## Why

The frontier-round interview (change `brainstorm-frontier-interview`) fixed how the
brainstorm phase asks questions, but four researched gaps remain: feasibility
questions get forced through the full design pipeline (no spike path); a question
only an absent stakeholder can answer stalls the interview or gets guessed; the
spec self-review is clerical and never tries to break the design; and terminology
drift against a project glossary goes unchallenged, with ADR-worthy decisions left
unmarked for the archive flow. The user approved shipping these four (P5–P8 of the
research report) as one change.

## What Changes

- `skills/forge/skills/brainstorming/SKILL.md`:
  - **Spike classification** before the interview: feasibility-shaped requests get
    a time-boxed throwaway investigation ending in a recommendation — no spec, and
    spike approval never authorizes implementation.
  - **Questionnaire escape hatch** in the interview: a frontier question only an
    absent person can answer marks its branch blocked in the ledger and produces a
    hand-off `questionnaire-<slug>.md` at the repo root; the rest of the frontier
    continues.
  - **Scenario red-team** as spec self-review check 6: invent 2–3 concrete
    edge-case scenarios; any the design cannot answer becomes an open question or
    explicit Assumption.
  - **Domain pass**: when `CONTEXT.md` exists, challenge glossary conflicts and
    sharpen fuzzy terms during the interview; decisions passing the ADR triple
    test are prefixed `ADR-candidate:` in `decisions.md` for the archive-to-adr
    flow.
- `skills/forge/phases/brainstorm.md`: spike terminal state — report the
  recommendation and end via `forge phase skipped --exit-reason "spike: …"`,
  bypassing plan.

## Capabilities

- `brainstorm-interview`: brainstorm-phase behavior — delta at
  `specs/brainstorm-interview/spec.md`

## Impact

Instruction-file (markdown) change only; no CLI code, no config schema change.
design.md skipped: small single-capability change building directly on the
just-archived design, no high-risk surface — the shapes and their sources are
recorded in the session brainstorm notes and the delta spec.
