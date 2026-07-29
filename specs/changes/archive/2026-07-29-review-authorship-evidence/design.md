# Design

## Context

Measured facts this design rests on. Each was run, not recalled — the last
design in this area shipped two load-bearing claims that an independent review
refuted, so every number here names how it was obtained.

| fact | how measured |
|---|---|
| `description` present on **388/388** sidecar metas (grew from 383 during the session; re-measured at each use) | walked `~/.claude/projects/*/*/subagents/*.meta.json` |
| **123** of those are review-shaped, and **1** matches the prescribed pattern | same walk, `/review/i` |
| `description` joins **4/4** review artifacts on the richest real session | compared `group-0N-*/group-review.md` and `reviews/final-review.md` against sidecars in the session window |
| `stoppedByUser: true` on 5 metas, one a final-review dispatch | same walk |
| `forge evidence` compliance ~50% (42/72 loose, 29/68 strict) | counted template markers in every `test-evidence.md` across three projects |
| `agentType` is `general-purpose` for 284/388 | same walk — so agentType alone cannot discriminate a reviewer |
| a one-day-old session already has no surviving host transcript | `forge metrics collect` on `sync-tasks-md-progress` |
| `finalReview` drives a 29-point cap | re-scored session-telemetry: *"capped at 69 (was 98)"* |
| the census has **five** consumers | grep: `set-phase.mjs`, `score.mjs` ×2, `ledger.mjs`, and `fleet-report.mjs` via the digest |

## Decisions

- **Decision: authorship is measured from host sidecars, not read from prose.**
  - Alternatives considered: refine the regex again (five rules, five failures,
    two at a gate); drop the independent/self distinction (it is the input to the
    money/auth floor).
  - Rationale: the review file is written by the party being judged. A sidecar
    cannot be fabricated without actually dispatching a subagent that burns
    tokens and writes a transcript.

- **Decision: the join key is the dispatch `description`, prescribed as `forge-review <unit>`.**
  - Alternatives considered: `toolUseId` (the coordinator never observes it);
    `agentType` (`general-purpose` for 284/383); a new `forge review record`
    command (rejected below).
  - Rationale: coordinator-authored at dispatch, host-recorded, universally
    present, and already joining correctly with ad-hoc wording. Prescribing the
    format changes a field the coordinator already fills in.

- **Decision: no coordinator-run attestation command.**
  - Alternatives considered: `forge review record --reviewer dispatched`.
  - Rationale: measured `forge evidence` compliance is ~50%. A gate resting on a
    command being run fails more often than the wording bug it replaces —
    *forgot a command* beats *phrased a heading unusually*. If an attestation is
    ever added it must only be able to **demote**, never to promote against
    contradicting host evidence.

- **Decision: scope to `finalReview`.**
  - Alternatives considered: every review artifact.
  - Rationale: `finalReview` drives the gate and the 29-point cap; per-group
    counts are worth ~2 points. One fact per session, and every fallback rule's
    blast radius shrinks to a single file.

- **Decision: per-verdict `evidence: 'host' | 'recorded' | 'inferred' | 'none'`.**
  - Alternatives considered: a session-level `source: 'mixed'`.
  - Rationale: the gate reads exactly one artifact. A session-level "mixed"
    tells it nothing about the one it cares about.

- **Decision: unavailable evidence falls back; it never refuses.**
  - Alternatives considered: treat unavailable as self (fail closed).
  - Rationale: every defect in this subsystem — five in `reviewCensus`, one in
    `resolveAdrInstallOptions`, one in `fleet-report` — was **absence of a signal
    read as a negative signal**. `set-phase.mjs` already states the rule:
    *"cannot judge risk — do not invent a refusal."* Failing closed here refuses
    correct work on Cursor, Codex and any pruned transcript.

- **Decision: absence of the prescribed label is not absence of a reviewer.**
  - Alternatives considered: trust the label unconditionally (what this design
    originally said); ship 4.1 first and accept the gap for older sessions.
  - Rationale: **measured after the design was approved** — of 388 real dispatch
    records, 123 are review-shaped and **1** matches the prescribed pattern.
    Under the original rule every genuine reviewer in the corpus would read as
    "no reviewer ran", and the spec turns that into `self` with prose *not*
    consulted, so the money/auth gate would refuse nearly every session. The
    design's claim that a mislabelled dispatch "falls back to prose … under-
    credits rather than over-credits" was **false**: there was no such fallback.
  - So the evidence layer reports how many dispatches it saw and how many were
    prescribed, and the decision layer distinguishes three states: *convention
    in use and this unit absent* → `self`; *dispatches seen, none prescribed* →
    convention not in use, fall back to prose; *no dispatches at all* → `self`.
  - This is the same rule as everywhere else in this change — an absence of
    signal is not a negative signal — applied to adoption rather than to reads.

- **Decision: the verdict is frozen at collection time.**
  - Alternatives considered: recompute on demand.
  - Rationale: transcripts expire within days. A verdict that silently changes
    when the evidence is pruned is worse than no verdict.
  - **Correction, measured after group 3.** An earlier version of this decision
    said freezing at the transition *makes the reading sound*. It does not. An
    independent reviewer reproduced the counterexample: a Forge session created
    **after** this one can dispatch its reviewer **before** this one's
    transition, so the dispatch is already inside `[createdAt, now]` when `now`
    really is now. Freezing narrows the window; it does not close it. The
    residual — a session credited with an interleaved session's reviewer, frozen
    on `host` grade into the durable ledger — is recorded as its own finding and
    is fixed upstream by a two-sided window or per-session dispatch attribution,
    not here.

- **Decision: the dispatch description names the Forge session, and attribution
  is an equality test.** `forge-review <unit> <forge-session-id>`, printed by
  `forge review-label <unit>`.
  - **Supersedes three earlier attempts at the same problem**, each rejected by
    an independent final review after the previous one was measured:
    1. a time window `[createdAt, now]` — a session created *later* can dispatch
       *earlier* than this one's transition, so its reviewer lands inside;
    2. "no other session overlapped the window" — `phase: done` ends the Forge
       session, not the host conversation, so a settled neighbour can still
       dispatch into the same sidecar directory;
    3. "no other session was ever bound to this host session", read from live
       `session.json` files and the ledger — `phases/finish.md` prescribes
       `forge cleanup` on the line after `forge phase done`, which deletes the
       directory, and a ledger line written before the binding field says
       nothing at all.
  - Each attempt was a money/auth gate passing on someone else's evidence: a
    review file declaring `Reviewer: coordinator — self-check` in Forge's own
    prescribed words scored `independent`/`host` at 93. The rejections were
    right each time, and the pattern is the point — every fix inferred
    attribution from something *adjacent* to the dispatch, and each inference
    had a shape that broke it.
  - The join now carries the answer. A record either names the session that
    dispatched it or it is counted for nobody, so there is nothing left to
    infer: **no window, no sibling search, no durable index of who shared
    what.** `notSoleOwner`, the digest `host` field and the `now`/`sessionsDir`
    inputs all went with the inference.
  - Alternatives considered: `toolUseId` (the coordinator never observes it); a
    Forge-written attestation file (rejected earlier — measured `forge evidence`
    compliance is ~50%, and a gate resting on a command being run fails more
    often than the bug it replaces).
  - **A command prints the label** because a convention that must be transcribed
    is a convention that is not adopted: almost no real dispatch record carries
    the label, and of those that do almost none carries a session id. The count
    is kept in `review-census.mjs` alone — it moves daily, and four copies of it
    went stale in four different ways during this change.
    `forge review-label final` is one line, and a test asserts its output
    round-trips through the real reader so the docs cannot drift from the code.
  - **Measured consequence.** The previous design graded 0 of 12 sessions on
    this machine once it was made sound — two blocked each other by sharing a
    conversation, two wanted a ledger, the rest were never bound. This design
    grades any session whose reviewer carried the label, including the ones
    that share a conversation, because sharing no longer matters.
  - Cost, stated plainly: a dispatch in the older two-word form is attributable
    to nobody, so it reports unavailable and the census reads the prose. That is
    every dispatch made before this ships — the fallback, not a refusal.

- **Decision: scope stops at the label.** `forge review-label` resolves the
  session itself and refuses when more than one is unfinished. Making *every*
  Forge command resolve consistently — including `forge phase done`, which with
  two sessions open gates the wrong change — is a real and larger bug found
  while building this, and it is `specs/changes/session-resolution/`, not here.
  Bundling it took a two-file change past thirty files and four review rounds
  that were about the bundled part rather than about authorship.

- **Decision: `stoppedByUser` is reported, not auto-waived.**
  - Alternatives considered: apply `--final-review-waived` automatically.
  - Rationale: declining a reviewer is the operator's decision to record. Forge
    should surface the fact and name the remedy, not decide on their behalf.

- **Decision: `CENSUS_RULE` bumps to 4.**
  - Rationale: classification changes, so rule-3 digest lines must not be summed
    with rule-4 ones. The mechanism shipped in 0.3.28.

## Risks / Trade-offs

- **Claude Code only.** Sidecars are a Claude Code artifact; Cursor and Codex land
  on the fallback permanently. Accepted — the fallback is today's behaviour, not a
  regression, and this is stated in the proposal rather than glossed.
- **The prescribed description is a convention, not an enforcement.** A
  coordinator that dispatches a reviewer with the wrong description produces
  evidence Forge cannot join. **An earlier version of this bullet claimed that
  "falls back to prose … under-credits rather than over-credits". That was
  false** — there was no such fallback, and the measurement (1 prescribed
  dispatch in 388) meant the original rule would have declared nearly every real
  session self-reviewed and refused it at the gate. The adoption decision above
  supplies the fallback the claim assumed. The convention is still unenforced,
  so adoption stays gradual and the prose path stays live indefinitely.
- **F18/F19 survive on the fallback.** The prose rule keeps its known escapes for
  every host without sidecars. Blast radius reduced, not closed.
- **Freezing can preserve a wrong verdict.** If the verdict is computed once and
  the evidence was misjoined, re-collection will not correct it. Mitigated by
  recording the evidence grade alongside, so a later reader can tell how the
  verdict was reached.
- **This change touches a gate.** It has been wrong five times. Pace resolved
  `thorough`; per-task review and an independent final review are not optional
  here.
