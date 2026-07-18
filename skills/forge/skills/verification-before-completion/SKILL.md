---
name: verification-before-completion
description: Forge — verify before claiming done. Internal skill; read via forge orchestrator.
---

# Verification Before Completion

Claiming work is complete without verification is dishonesty, not efficiency.

**Core principle:** Evidence before claims, always. Violating the letter of this rule is violating the spirit of this rule — it applies to exact phrases, paraphrases, and any wording implying success.

## Forge — coordinator verify phase

Three tiers: [test-strategy.md](../../references/test-strategy.md).

**During implement:** implementers use tier 1 (scoped TDD) and tier 2 (narrow task evidence in `test-evidence.md`).

**During verify:**

1. **Audit** tier 2 evidence per task — exit code, pass summary, reviewer approvals. Do **not** re-run tier 2 commands.
2. **Run tier 3 once** — fresh full workspace test per affected workspace (plus consumer workspaces if contracts changed). Save to `verify-evidence.md`.
3. Cite tier 3 output when claiming the implementation passes.

Re-run tier 3 only when it failed, coordinator edited code after verify evidence, reviewers flagged gaps, or the user asks. Per-task tier 2 runs **are** evidence for task-scoped claims; tier 3 **is** evidence for "full workspace passes." Do not duplicate tier 2 at verify; do not skip tier 3 because tier 2 passed; never run full workspace per implement task.

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

Before claiming any status or expressing satisfaction ("Done!", "Great!", "should work"):

1. **IDENTIFY** the command that proves the claim
2. **RUN** it fresh and complete
3. **READ** full output — exit code, failure count
4. **VERIFY** the output confirms the claim; if not, state the actual status with evidence
5. Only then make the claim, **with** the evidence

Skip any step = lying, not verifying.

## What each claim requires

| Claim | Requires | Not sufficient |
|-------|----------|----------------|
| Tests pass | Test command output: 0 failures | Previous run, "should pass" |
| Linter clean | Linter output: 0 errors | Partial check, extrapolation |
| Build succeeds | Build command: exit 0 | Linter passing, logs look good |
| Bug fixed | Test of original symptom: passes | Code changed, assumed fixed |
| Regression test works | Red-green verified (revert fix → must fail → restore → pass) | Test passes once |
| Agent completed | VCS diff shows the changes | Agent reports "success" |
| Requirements met | Line-by-line checklist vs the plan | Tests passing |

## Red flags — stop and run the verification

"Should / probably / seems to" · satisfaction before evidence · committing or moving to the next task unverified · trusting an agent's success report · partial checks ("linter passed" ≠ build) · "I'm confident" (confidence ≠ evidence) · "just this once" · tired and wanting the work over.
