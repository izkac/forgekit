# Review phase

Per-task reviews happen inside [implement.md](./implement.md). This phase covers **final** review before finish.

Read and follow [../skills/requesting-code-review/SKILL.md](../skills/requesting-code-review/SKILL.md).

**Pace:** Check `review.final` via [../references/pace.md](../references/pace.md) / `forge status`. If pace skips final review and the session is not high-risk, write `.forge/sessions/<id>/reviews/final-review.md` with `SKIPPED (pace=…)` and proceed. High-risk sessions (money/auth/contracts/migrations) always get a final review (hard floor).

Otherwise dispatch the final reviewer using [../subagents/final-reviewer-prompt.md](../subagents/final-reviewer-prompt.md) (whole-session verdict; the reviewer applies the checklist from [code-reviewer.md](../skills/requesting-code-review/code-reviewer.md)).

**Model:** `forge resolve-model --tier capable` (or `standard`/`fast` when `models.bias` is `prefer-fast` and not high-risk; billing **`included`** by default). If `omitModel` is true, omit the Task `model` parameter; otherwise pass `model` exactly. Do not use metered/API models unless the user explicitly requests them.

<HARD-GATE>
Do NOT hand-pick a model slug for the final reviewer — not even "the most capable" from the host's model list. Resolver output only. On dispatch failure, re-resolve; do not substitute a slug yourself.
</HARD-GATE>

Save output to `.forge/sessions/<id>/reviews/final-review.md`.

```bash
forge phase review
```

Address Critical and Important findings before finish.

Then proceed to [finish.md](./finish.md).
