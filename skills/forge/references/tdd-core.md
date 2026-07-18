# TDD core (condensed — inject into implementer briefs)

Full skill: [skills/test-driven-development/SKILL.md](../skills/test-driven-development/SKILL.md) — read it only when stuck (hard-to-test design, mock-heavy setup, unclear failures). Anti-patterns for mocks/test utilities: [testing-anti-patterns.md](../skills/test-driven-development/testing-anti-patterns.md).

## Iron Law

**No production code without a failing test first.** Wrote code before the test? Delete it and start over — don't keep it as "reference".

## The loop

1. **RED** — write one minimal test for one behavior. Clear name, real code (mocks only if unavoidable).
2. **Verify RED (mandatory)** — run the scoped test; confirm it *fails* for the right reason (feature missing, not a typo/error). Passes immediately? You're testing existing behavior — fix the test.
3. **GREEN** — simplest code that passes. No extra features, options, or "improvements" beyond the test (YAGNI).
4. **Verify GREEN (mandatory)** — re-run the same scoped file/pattern; output pristine. Test fails? Fix code, not test.
5. **REFACTOR** — dedupe, rename, extract; stay green; no new behavior.
6. Repeat with the next failing test.

## Test tiers (Forge)

- **Tier 1 (each red/green cycle):** single test file or pattern — never the full workspace suite.
- **Tier 2 (task done):** narrowest command proving this task — changed tests + directly related tests. Full workspace runs **once at verify (tier 3)**, not per task. Report command + exit code + pass/fail summary.

## Red flags — stop and start over

Code before test · test passes immediately · can't explain the failure · "I'll test after" · "already manually tested" · "too simple to test" · "keep as reference / adapt existing code" · "deleting X hours is wasteful" (sunk cost) · "run full workspace to be safe" (tier 3 belongs at verify) · "just this once".

## Bugs

Reproduce with a failing test first, then fix. Never fix a bug without a test.
