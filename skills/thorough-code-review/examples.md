# Thorough code review — examples

## 1. Full review (all lenses, branch diff)

**User:** "Review my branch before I open a PR."

**Agent:**

1. Ask scope → user picks "Branch vs main".
2. Scaffold: `review new mercury-vat --type branch` (captures id, timestamp, base/head SHAs).
3. Signals pre-flight: `review signals --type branch` → run the listed typecheck/test commands; 1 grounded finding from a failing test.
4. All lenses active; dedupe pre-flight (smells).
5. Scout → 8 tentative findings (small scope, single pass).
6. Coverage pass → confirms `performance` lens clean (no loops/queries added); records ledger.
7. Eight parallel skeptic subagents; one Critical `false_positive` triggers a second skeptic (agrees).
8. Fill JSON → `review render` → `review export`.

**Excerpt — executive summary (`summary.headline`):**

```markdown
Reviewed 4 files on `feature/vat` vs `main`. 8 tentative → 3 confirmed, 2 downgraded,
3 false positives. No open critical. Top action: add test for zero-rate edge case.
```

## 2. Security-only narrow review

**User:** "Run a security review on `services/persona/src/routes/profile.ts` --security"

**Agent:**

1. Scope: single path (no ask needed — explicit).
2. Lenses: `security` only — skip dedupe pre-flight.
3. Scout with security checklist + project accepted-risks digest (if any).
4. Severity-routed skeptic dispatch (dedicated for critical, batched/inline otherwise; within budget).
5. Report: `.reviews/20260605T162000Z-persona-profile-security-review.json`

## 3. Fix verification after patches

**User:** "I fixed the findings — re-verify."

**Agent:**

1. Load `.reviews/20260605T161200Z-mercury-vat-review.json`.
2. Three findings were `confirmed` or `downgraded`.
3. `--verify-fixes` flow: skeptics with `MODE=reverify`, severity-routed and batched like initial mode.
4. Write `.reviews/20260605T170000Z-mercury-vat-reverify.json`:

```json
{
  "review_id": "20260605T170000Z-mercury-vat-reverify",
  "kind": "reverify",
  "parent_report": "20260605T161200Z-mercury-vat-review",
  "findings": [
    {
      "id": "F-002",
      "verdict": "resolved",
      "verdict_reason": "Guard added at line 88; test added in vat-verify.test.ts"
    },
    {
      "id": "F-005",
      "verdict": "still_open",
      "verdict_reason": "Error path still swallows exception at line 102"
    }
  ]
}
```

## 4. CI usage

After a review completes:

```bash
# Validate latest report
review export

# Pin specific report in CI
review export --file .reviews/20260605T161200Z-mercury-vat-review.json

# Fail pipeline on open critical
review export --file .reviews/20260605T161200Z-mercury-vat-review.json --fail-on critical

# Copy artefacts for upload
review export --out ./ci-artifacts/review
```

**GitHub Actions sketch:**

```yaml
- name: Validate code review report
  run: review export --file .reviews/pr-review.json --fail-on critical
```

## 5. Skeptic false-positive example

**Scout F-003:** "Race condition in idempotency check-then-act."

**Skeptic verdict:** `false_positive`

**Reason:** "Handler uses unique index `create` collision path; integration test `idempotency.test.ts` asserts single side effect under concurrent requests. Non-atomic window exists but duplicate work is prevented at persistence layer."

→ Appears in Appendix A, not main findings.

## 6. Dedupe pre-flight example

**Scope:** `services/*/src/middleware/idempotency.ts` (smells in "all" review)

**Pre-flight dup-001:** Same idempotency middleware copied in cdp, mercury, persona.

→ Merged as tentative `dup-001` / smells / Important → skeptic confirms → main report suggests shared package extraction.

## 7. Signals pre-flight grounds the scout

**User:** "Review `services/persona` --tests --contracts"

**Agent:**

```bash
review signals --paths services/persona
#   Workspaces: your-workspace
#   npm run typecheck --workspace=your-workspace
#   npm run test --workspace=your-workspace
#   Notes: Contract/route files touched — verify OpenAPI route-parity (contracts lens).
```

`npm run test --workspace=your-workspace` fails one route-parity case → grounded `F-001` / contracts / Important, `confidence: high`, tool output as evidence. Recorded in JSON `signals.tools`.

## 8. Risk-weighted second skeptic

**Scout F-002:** "IDOR on `GET /profile/:id`" — `severity: critical`, `phase1_confidence: high`.

**Skeptic 1 verdict:** `false_positive` ("CLM binds actor server-side").

→ Dangerous quadrant (critical + high-confidence dismissed). A **second independent skeptic** is dispatched blind. It also returns `false_positive`, citing ADR-0048 and the signed-JWT actor binding. `second_opinion.agrees: true` → finding stays in Appendix A, now with two concurring dismissals. Had they disagreed, it would route to `needs_decision`.
