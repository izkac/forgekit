# Phase 1 — Scout pass

You are the **scout** for a thorough code review. Discovery only — no fix suggestions yet.

## Input packet

- **Scope:** {SCOPE_TYPE} — {SCOPE_DESCRIPTION}
- **Lenses:** {LENS_LIST}
- **Git range / paths:** {SCOPE_DETAIL}
- **Accepted risks:** {ACCEPTED_RISKS_DIGEST}  <!-- contents of reference/accepted-risks.md — do not raise findings it covers unless a re-open trigger fired -->

## Steps

1. Ingest the **signals pre-flight** results ([signals-preflight.md](signals-preflight.md)) — tool-confirmed failures are grounded findings; start from them.
2. Read the files in scope (`git diff`, paths, or commits as applicable). **Partition large scopes** — see below.
3. If **smells** lens is active: run dedupe pre-flight (read `dedupe` skill; report-only scan on scope).
4. For each active lens, read the checklist from [lenses.md](lenses.md) and inspect code.
5. Emit **tentative findings** — de-duplicate overlapping claims before handing off.
6. Do **not** assign final verdicts; Phase 2 skeptics do that. The coverage pass ([phase1c-coverage.md](phase1c-coverage.md)) runs after you to catch misses.

## Scaling — partition large scopes

A single scout reading every file degrades once the scope is large (context pressure → shallow reads → missed findings).

- **Small scope** (≲10 files / ≲800 changed lines): one scout pass.
- **Large scope:** split into reviewable **units** — by module/directory, or by lens — and run one scout subagent per unit **in parallel**, capped at **4 scouts** (grow the unit size, not the scout count). Each unit owns a slice; none needs the whole tree in context. Each scout writes its findings to `.reviews/<id>-tentative/<scout-name>.json` (`{ "findings": [...] }`).
- **Merge:** `review merge --dir .reviews/<id>-tentative` — dedupes overlapping claims (same file, line ±5, same lens; keeps the stronger finding, records merged ids in `related`) and renumbers `F-###` deterministically into `merged.json`.

## Tentative finding format

Each finding MUST include all fields:

```
id: F-001          # or dup-001 from pre-flight
lens: security
location: services/foo/src/bar.ts:42
claim: One-sentence description of the suspected issue
evidence: |
  ```42:48:services/foo/src/bar.ts
  // cited lines
  ```
context: |         # ±30 lines around the citation — lets the skeptic verdict without re-discovering the file
  ...
related: []        # callers, test files, ADR paths — you already found these; hand them over
tentative_severity: critical | important | minor
confidence: low | medium | high
```

The `context` and `related` fields are what keep Phase 2 cheap: you already read this code — package it so the skeptic doesn't have to rediscover it.

## Rules

- Every finding needs `file:line` (or line range) and a code citation.
- Prefer fewer, higher-quality findings over laundry lists.
- "Might be wrong" is fine — skeptics verify. Mark `confidence: low` when unsure.
- Check ADRs for accepted-risk patterns before claiming security issues.
- Record scope and lens list for the synthesis report header.

## Handoff

1. Run the **coverage pass** ([phase1c-coverage.md](phase1c-coverage.md)) on the merged tentative list — it may add follow-up findings and records the `coverage` ledger.
2. Pass the full tentative list (scout + coverage) to Phase 2. Skeptic dispatch is severity-routed and budgeted (see SKILL.md) using [phase2-skeptic.md](phase2-skeptic.md) — not one subagent per finding.
