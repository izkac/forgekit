# Tasks

## 1. Brainstorming skill extensions

- [x] 1.1 Add **spike classification** to
      `skills/forge/skills/brainstorming/SKILL.md`: a short section before the
      interview flow — classify feasibility-shaped requests as spikes (time-boxed
      throwaway investigation, code labeled throwaway, output is a
      recommendation, no spec/design doc; spike approval is never implementation
      approval; follow-up work restarts brainstorm with the findings). Verify:
      `grep -ci spike` on the file ≥ 3.
- [x] 1.2 Add the **questionnaire escape hatch** to the interview section of the
      same file: when a frontier question can only be answered by someone not in
      the session, mark the branch blocked in the ledger, write
      `questionnaire-<slug>.md` at the repo root (purpose, recipient, one context
      paragraph, gap-targeted questions most-important-first with answer stubs),
      tell the user to send it, keep interviewing the rest of the frontier;
      blocked branches resolve from answers or are promoted to explicit
      Assumptions with user consent. Verify: `grep -c questionnaire` ≥ 2.
- [x] 1.3 Add **scenario red-team** as spec self-review check 6 in the same file:
      invent 2–3 concrete edge-case scenarios probing the design's boundaries;
      any scenario the design cannot answer becomes an open question to the user
      or an explicit Assumption — never silently dropped. Verify: self-review
      list has 6 numbered checks.
- [x] 1.4 Add the **domain pass** to the same file: during the interview, when
      `CONTEXT.md` exists, challenge terms conflicting with the glossary and
      propose precise canonical terms for fuzzy/overloaded ones; when writing
      `decisions.md`, prefix entries passing the ADR triple test (hard to
      reverse AND surprising without context AND a real trade-off) with
      `ADR-candidate:` for projects with ADRs enabled. Verify:
      `grep -c "ADR-candidate"` ≥ 1 and `grep -c CONTEXT.md` ≥ 1.

## 2. Phase wiring and sweep

- [ ] 2.1 Update `skills/forge/phases/brainstorm.md`: add the spike terminal
      state (spike → report recommendation → `forge phase skipped --exit-reason
      "spike: <question>"`, never the plan pipeline). Then sweep
      `skills/forge/` for contradictions with the four additions (e.g. text
      implying every brainstorm ends in a spec). Verify: `grep -ci spike` on
      phases/brainstorm.md ≥ 1; sweep report lists any kept hits.
