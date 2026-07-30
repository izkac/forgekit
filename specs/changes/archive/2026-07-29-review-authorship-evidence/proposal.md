# Review authorship is measured, not read

## Why

`reviewCensus` decides whether a review was written by a dispatched subagent or
by the coordinator itself. It decides by reading the review file's **prose** —
text written by the party being judged.

That verdict is not cosmetic. It drives the money/auth `forge phase done` gate
(`set-phase.mjs`), a **29-point** scorecard cap (`score.mjs`, measured: *"capped
at 69 (was 98)"*), the durable `sessions.jsonl` digest, and cross-project totals
in `forge fleet report`.

The rule was rewritten **five times in one day** — 0.3.24, two intermediate
revert rules, 0.3.26, 0.3.27 — and every version was wrong in one direction or
the other. Two were wrong *at the gate*:

- a genuine dispatched review heading `Reviewed:` was demoted, so `forge phase
  done` **refused** a high-risk session whose independent review already existed
- a real final review reading *"a final-reviewer subagent was dispatched and
  **declined by the operator**"* was promoted, so the money/auth floor **passed**
  the exact case it exists for

Each fix was found by an outside reader, never by the author's own verification.
The conclusion is not that the regex needs another pass.

## What Changes

The host already writes a sidecar per subagent it actually ran —
`agent-<id>.meta.json` plus a transcript — and a coordinator cannot fabricate one
without really dispatching. That is **evidence**. The review file is
**testimony**. Forge should prefer the former.

> **Corrected in 0.3.34.** The paragraph above is left as it was written, and it
> overclaims in the same way the 0.3.29 CHANGELOG entry did. Really dispatching
> is cheap: a throwaway subagent carrying the label made one request, reviewed
> nothing, and its sidecar passed the money/auth gate (F33). The distinction
> between evidence and testimony holds — the reviewed party cannot *write* a
> sidecar — but a sidecar proves a dispatch, not a review. `review-dispatch-
> substance` adds a request floor so a dispatch that did no work no longer
> certifies. That is still not proof the work was a review; F12 is.

- **A prescribed dispatch description.** Reviewer subagents are dispatched with
  `forge-review final` / `forge-review <unit>`. `description` is coordinator-
  authored at dispatch and host-recorded, present on **383/383** metas measured,
  and it already joins 4/4 review artifacts on the richest real session using
  today's ad-hoc wording. Prescribing it makes the join exact. It changes a field
  the coordinator already fills in — no new command to forget.
- **`reviewerSidecars()`** in `metrics/` reads those metas for the session's bound
  host sessions, windowed by the session's own timespan, returning identifiers
  and counts only — never the description text.
- **`reviewCensus` gains per-verdict evidence**: `host` > `recorded` > `inferred`.
  Scoped to `finalReview`, the one verdict that drives the gate and the cap.
- **Absence never refuses.** Host evidence *available and showing no reviewer* →
  self. Host evidence *unavailable* (Cursor, Codex, a pruned transcript) →
  today's prose behaviour. `set-phase.mjs` already states the rule: *"cannot
  judge risk — do not invent a refusal."*
- **The verdict is frozen** into `session.json` and the digest when collected.
  Measured: a one-day-old session already has no surviving host transcript.
- **`stoppedByUser` is surfaced.** The host records when an operator declines a
  dispatch — present on 5 metas, one of them a final-review dispatch. Forge has
  been hitting "dispatched then declined" all week with no field for it.

## Capabilities

- `review-evidence` — authorship measured from host sidecars, with an explicit
  evidence grade and a fallback that cannot refuse work.

## Impact

**Behaviour.** A session with host evidence gets a verdict that no wording can
change. A session without one behaves exactly as 0.3.28 does today.

**Scope discipline.** Per-group `independent` / `selfChecks` counts stay on
prose: they are worth ~2 points, and leaving them alone keeps this change to one
fact per session instead of one record per artifact.

**Data contract.** `session.json` gains a frozen verdict; the digest gains
evidence, and `CENSUS_RULE` bumps to 4 so cross-project totals do not silently
mix scales (that mechanism shipped in 0.3.28).

**Not fixed by this change.** F18 and F19 — the prose rule's known escapes —
survive on the fallback path, which is exactly where hosts without sidecars land.
This reduces their blast radius; it does not close them. Saying otherwise would
repeat the mistake this change exists to correct.

**Privacy.** Sidecar reads persist identifiers, counts and timestamps only.
`transcript.mjs` already forbids carrying `description` through, and prescribing
its *format* does not license storing its *text*.

## Decision record

To be recorded as an ADR on archive.

## Decision record

No ADR — the architectural decision (authorship is measured from host dispatch
records, attributed by the session id in the description) is already recorded in
`design.md` here and in ADR-0003/0004's neighbourhood; this change refines the
same boundary rather than establishing a new one.
