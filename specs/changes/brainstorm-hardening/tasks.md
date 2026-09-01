# Tasks

## 1. Plan gate

- [x] 1.1 Add `enforceBrainstormNotesGate` to `packages/cli/src/set-phase.mjs`
      (guarded on `phase === 'plan'` AND a `brainstorm` entry in
      `session.phaseHistory`; requires `<sessionDir>/brainstorm/notes.md`
      matching `/^##\s+Assumptions\b/m`; refuses with a message naming the file,
      the missing piece, and the waiver; `--notes-waived "<reason>"` parsed like
      the other waivers → `session.notesWaived`; usage string updated). Add
      `notesWaived` to the sessions.jsonl row in `packages/cli/src/ledger.mjs`.
      TDD in `packages/cli/src/set-phase.test.mjs`: refuse when notes.md
      missing; refuse when heading missing; pass with heading; skip when no
      brainstorm in history; waiver records the field and allows the
      transition. Tier 2: `node --test packages/cli/src/set-phase.test.mjs`.

## 2. Quality signals

- [x] 2.1 In `packages/cli/src/brief-cli.mjs` `stamp`: after a successful
      `stampBrief`, increment `session.briefStamps` (default 0) and, when
      `session.phaseHistory` contains an `implement` entry, also
      `session.briefRestampsAfterImplement`; `saveSession`. TDD in
      `packages/cli/src/brief.test.mjs` (first stamp → 1/0; re-stamp after
      implement in history → 2/1). Tier 2:
      `node --test packages/cli/src/brief.test.mjs`.
- [x] 2.2 In `packages/cli/src/ledger.mjs`: add to the digest row
      `briefStamps`, `briefRestampsAfterImplement`, and
      `brainstorm: { notes, assumptions, adrCandidates }` parsed from the
      session dir's `brainstorm/notes.md` (`- ` bullets under `## Assumptions`
      until the next `##`) and `brainstorm/decisions.md` (`ADR-candidate:`
      count); parser never throws, defaults null/0 when files are gone. In
      `packages/cli/src/analyze.mjs`: carry the fields on session rows; totals
      gain `specChurnSessions` and `meanAssumptions`; `formatAnalysis` prints
      one summary line. TDD in `ledger.test.mjs` and `analyze.test.mjs`.
      Tier 2: `node --test packages/cli/src/ledger.test.mjs
      packages/cli/src/analyze.test.mjs`.

## 3. Docs and product loop

- [x] 3.1 Docs: in `skills/forge/skills/brainstorming/SKILL.md` (After the
      Design) add the durable-answer promotion step — scan interview answers
      for permanent project truths and offer, with user consent, promotion to
      `CONTEXT.md` (domain terms), `AGENTS.md` (agent workflow rules), or an
      `ADR-candidate:` entry in decisions.md; never promote silently. In
      `skills/forge/phases/brainstorm.md` document the plan gate and
      `--notes-waived`. No TDD (docs).
- [x] 3.2 Product-loop acceptance: add harness phase `brainstorm-gate` to
      `scripts/e2e/harness-portability.mjs` (own scratch project, modeled on
      `archive-gate` at ~2821): refuse missing notes; refuse missing heading;
      pass with a real `## Assumptions` section; waiver session records
      `notesWaived`; print `BRAINSTORM GATE GREEN`. Author the change's
      `e2e.json` step (`node scripts/e2e/harness-portability.mjs
      brainstorm-gate`, expect `BRAINSTORM GATE GREEN`) and finish with a green
      `forge e2e run`.
