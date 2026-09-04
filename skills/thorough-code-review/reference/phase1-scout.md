# Phase 1 — Scout pass

You are the **scout** for a thorough code review. Discovery only — no fix suggestions yet.

## Input packet

- **Scope:** {SCOPE_TYPE} — {SCOPE_DESCRIPTION}
- **Lenses:** {LENS_LIST}
- **Git range / paths:** {SCOPE_DETAIL}
- **Signals:** {SIGNALS_SUMMARY}  <!-- which grounding tools ran, and their status -->
- **Accepted risks:** {ACCEPTED_RISKS_DIGEST}  <!-- contents of reference/accepted-risks.md — do not raise findings it covers unless a re-open trigger fired -->

## Steps

1. Ingest the **signals pre-flight** results ([signals-preflight.md](signals-preflight.md)) — tool-confirmed failures are grounded findings; start from them. A tool that ran green closes its lens: do not hand-scout `tests` behind a passing suite, or `contracts` behind a green route-parity check, unless that lens was explicitly requested.
2. Read the code in scope (see **What "in scope" means** below).
3. If the **smells** lens is active: run the dedupe pre-flight (read the `dedupe` skill; report-only scan on scope).
4. For each active lens, read the checklist from [lenses.md](lenses.md) and inspect code.
5. Emit **tentative findings** — de-duplicate overlapping claims before handing off.
6. Record your **coverage ledger** (below) — what you read, what you skipped, which lenses came up empty.
7. Do **not** assign final verdicts. Phase 2 skeptics verdict the severities the preset pays for; the rest are reported as `unverified` by the orchestrator.

## What "in scope" means

**Diff scopes (`uncommitted`, `branch`, `commit_range`) are read diff-first.** Your unit is the **changed hunk plus its enclosing function**. Unchanged code in a touched file is not yours: this change did not write it, and reading it is how a diff review turns into a repo audit.

Step outside the hunk only when a lens checklist item sends you there, and only as far as it sends you:

- a caller or callee whose contract this diff moved
- a guard, validation, or test the diff **removed** (read what it protected)
- the type or schema the changed line depends on
- the test file covering the changed path

That is directed reading and it is expected. Listing directories, grepping for related patterns, and reading neighbouring modules "for context" is not — it is most of what a review costs and almost none of what it finds.

**`paths` and `file` scopes** are whole-file reads by definition. Read them fully.

## Scaling — partition large scopes

A single scout reading every file degrades once the scope is large (context pressure → shallow reads → missed findings).

- **Small scope** (≲10 files / ≲800 changed lines): one scout pass.
- **Large scope:** split into reviewable **units** — by module/directory, or by lens — and run one scout subagent per unit **in parallel**, capped at the preset's scout count (`review new` printed it; grow the unit size, not the scout count). Each unit owns a slice; none needs the whole tree in context. Each scout writes `{ "findings": [...], "coverage": {...} }` to `.reviews/<id>-tentative/<scout-name>.json`.
- **Merge:** `review merge --dir .reviews/<id>-tentative` — dedupes overlapping claims (same file, line ±5, same lens; keeps the stronger finding, records merged ids in `related`), renumbers `F-###` deterministically, and folds the coverage ledgers into `merged.json`.

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

The `context` and `related` fields are what keep Phase 2 cheap: you already read this code — package it so the skeptic doesn't have to rediscover it. A below-threshold finding's packet is what the reader gets *instead of* a verdict, so make its evidence stand on its own.

## Coverage ledger (you write it — there is no separate coverage pass)

You are the cheapest thing that can say what you did not read: you were just there. Return this beside your findings:

```yaml
coverage:
  files_reviewed: [list]         # you actually read these
  files_skipped: [list]          # in scope, deliberately not read — say why in the reason
  lenses_without_findings:
    - lens: performance
      reason: no loops, queries, or allocations introduced
    - lens: tests
      reason: exercised by green suite (signals pre-flight), not hand-scouted
```

Rules:

- A zero-finding lens or skipped file is a **claim that needs a one-line justification** — not a silent gap.
- Before you finish, re-check your own blind spots: error/edge paths off the happy path, callers of a changed export, what the change **removed**, and config/migration files easy to skim past.
- Follow-ups from that self-check are capped at **3** and must be `important` or above. A recall pass that emits minors buys findings nobody verifies.

## Rules

- Every finding needs `file:line` (or line range) and a code citation.
- Prefer fewer, higher-quality findings over laundry lists.
- "Might be wrong" is fine — skeptics verify. Mark `confidence: low` when unsure.
- Check ADRs for accepted-risk patterns before claiming security issues.
- Record scope and lens list for the synthesis report header.

## Handoff

Pass the merged tentative list to Phase 2. Skeptic dispatch is severity-routed and budgeted (see SKILL.md) using [phase2-skeptic.md](phase2-skeptic.md) — at or above the preset's threshold only; the rest go to the report as `unverified`.
