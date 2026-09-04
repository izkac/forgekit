# Code review report template

**Generated, not hand-authored.** The JSON sidecar is the single source of truth; the paired markdown is produced from it by `review render --file <json>`. This file documents the structure the renderer emits — edit the JSON (and the renderer in the review CLI `lib.mjs`), never the `.md` directly.

Path: `.reviews/<timestamp>-<scope-slug>-review.md` (or `-reverify.md` for fix verification), per [report-schema.json](report-schema.json).

---

```markdown
# Code review — {SCOPE_DESCRIPTION}

**Review ID:** {REVIEW_ID}
**Kind:** review | reverify
**Created:** {ISO_TIMESTAMP}
**Scope:** {SCOPE_TYPE} — {SCOPE_DETAIL}
**Lenses:** {LENS_LIST}
**Preset:** {quick | standard | deep}
**Parent report:** {PARENT_REVIEW_ID or —}

## Executive summary

{TWO_TO_FOUR_SENTENCES: what was reviewed, verdict counts, overall risk posture.}

### Verdict counts

| Verdict | Count |
| ------- | ----- |
| Confirmed | |
| Downgraded | |
| Unverified | |
| False positive | |
| Needs decision | |
| Resolved | |
| Still open | |
| Partially fixed | |
| Regressed | |

### Top actions

1. {Highest priority confirmed/critical item}
2. {Second}
3. {Third}

---

## Critical

### {F-001}: {Short title}

- **Lens:** security
- **Location:** `path:line`
- **Severity:** critical {or `minor (was important)` when downgraded}
- **Verdict:** confirmed
- **Claim:** ...
- **Reason:** ...
- **Second skeptic:** {only when a critical was dismissed} verdict — reason

{Repeat per finding}

---

## Important

{Same structure}

---

## Minor

{Same structure}

---

## Needs decision

{Architectural items with `needs_decision` verdict — link ADRs if applicable}

---

## Unverified findings

{Findings below the preset's `verify_from` threshold: reported with the scout's
evidence, no skeptic verdict. Surfaced so the reader can judge them, never
counted as verified. Never a `critical`. Omitted when there are none.}

---

## Coverage ledger

{Folded from the scouts' own ledgers by `review merge` — files reviewed/skipped
and active lenses that produced no findings, each with a one-line reason.
Omitted when no `coverage` object.}

---

## Appendix A — Rejected findings (false positives)

### {F-00X}: {Short title}

- **Claim:** ...
- **Why rejected:** ...

---

## Appendix B — Dedupe pre-flight

{If smells lens ran; else omit section}

| ID | Location | Claim |
| -- | -------- | ----- |
| dup-001 | ... | ... |

---

## Appendix C — Method

- Phase 1: Scout pass ({N} tentative findings)
- Phase 2: Adversarial skeptic verification (severity-routed, budgeted; below-threshold findings reported unverified)
- {If reverify: Re-verification against parent report {PARENT_ID}}
```

## JSON sidecar

Author the `.json` (the source of truth), then `review render` to (re)generate this markdown and `review export` to validate before handing off in CI contexts.

Main report body includes only `confirmed` and `downgraded` findings (initial review) or `still_open`, `partially_fixed`, `regressed` (reverify). Render places `unverified` findings in their own section and `false_positive` in Appendix A automatically.
