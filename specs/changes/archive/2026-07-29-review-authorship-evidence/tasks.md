# Tasks

Every task is test-first: failing test, verified RED for the right reason, then
the code. Tier 1 per cycle, tier 2 per task, tier 3 once at verify.

**Derive every expected value from your fixture in code.** Figures quoted in a
brief are illustrative and have been wrong in this project before.

## 1. Read the evidence

- [x] 1.1 `packages/cli/src/metrics/review-evidence.mjs` — `readReviewerSidecars(sidecarDir, {filter})`
      pairs `agent-<id>.meta.json` with its transcript and returns one record per
      dispatch whose `description` carries the prescribed `forge-review` token:
      `{agentId, unit, requests, stoppedByUser, at}`. **`description` text is never
      returned.** Tests: prescribed token matched; ad-hoc description ignored;
      `stoppedByUser` carried; malformed meta skipped; missing dir → `[]`; a
      privacy test proving no description text reaches the output.
- [x] 1.2 `reviewEvidence({session, env, configDir, now})` resolves the session's
      bound host sessions via `findTranscripts`, windows records to
      `[session.createdAt, now]`, and returns
      `{available, units: {<unit>: {dispatched, stopped, requests}}, seen,
      prescribed, reason?}` — where `seen` counts every identifiable dispatch in
      the window and `prescribed` counts those carrying the review label, so a
      caller can tell *"the convention is not in use here"* from *"no reviewer
      ran"*. Tests: happy path; no binding → `available: false` with a reason;
      transcript pruned → `available: false`; a dispatch outside the window is
      excluded; `available: true` with zero units is distinct from unavailable;
      **`seen > 0, prescribed === 0` is distinct from `seen === 0`**.

## 2. Decide with it

- [x] 2.1 `reviewCensus` gains `finalReviewEvidence: 'host'|'recorded'|'inferred'|'none'`
      and accepts optional host evidence. Precedence host > recorded > inferred.
      **Prose is not consulted when host evidence is available.** Tests: a
      dispatched reviewer whose prose says `self-check` → `independent`/`host`;
      a self-written review headed `Reviewer: claude-opus-5` → `self`/`host`;
      evidence unavailable → verdict identical to today's prose rule, evidence
      `inferred`; no review file at all → `none`.
- [x] 2.1b **Adoption gate.** When evidence is available but `prescribed === 0`
      and `seen > 0`, the convention is not in use: fall back to prose with
      evidence `inferred`. When `prescribed > 0` and the unit is absent → `self`
      / `host`. When `seen === 0` → `self` / `host`. Measured why: of 388 real
      dispatch records, 123 are review-shaped and 1 is prescribed, so without
      this the gate refuses nearly every existing session. Tests: all three
      states, each asserting both verdict and evidence.
- [x] 2.2 `stoppedByUser` on a unit yields `self` plus a `stoppedByOperator` flag,
      and applies no waiver. Tests: stopped dispatch → `self`; the flag is
      reported; `finalReviewWaived` is untouched.
- [x] 2.3 Bump `CENSUS_RULE` to 4 and cover that a rule-3 digest line and a
      rule-4 one are reported as mixed by `fleet-report` (mechanism shipped in
      0.3.28 — this asserts the bump is wired, not the mechanism).

## 3. Freeze it

- [x] 3.1 `set-phase.mjs` computes evidence once on `finish`/`done` **before
      `enforceFinalReviewFloor()` (line 280)** — not merely before the scorecard
      (line 312), which is where the existing metrics collection sits and is too
      late for the gate to see it. Corrected after measuring the call order; the
      previous wording repeated the ordering defect that shipped in the
      session-telemetry change, where `bindHost` ran after the scorecard and a
      session's first `phase done` recorded `available: false` permanently.
      Stores `session.reviewVerdict = {final, evidence, stoppedByOperator}`.
      Advisory: a failure warns and the transition continues. Tests: the verdict
      lands on session.json; a thrown collection still completes the transition;
      **a test that fails if the computation is moved below the gate.**
- [x] 3.2 `ledger.mjs` carries the frozen verdict and its evidence into the
      digest. Tests: digest carries both; deleting the host transcript afterwards
      does not change the recorded values.
- [x] 3.3 `set-phase.mjs`'s done gate and `score.mjs`'s cap read the frozen
      verdict when present, falling back to a live census otherwise. **Tests must
      prove the gate does not refuse when evidence is unavailable** — that is the
      failure this change exists to avoid repeating.

- [x] 3.4 `fleet-report.mjs` must not sum review verdicts across **evidence
      grades**. `CENSUS_RULE` cannot fix this: rule 4 is *defined* as "host where
      it can, prose otherwise", so rule-4 lines carry both kinds permanently —
      measured today across 20 real sessions, 1 would be `host`, 7 `inferred`,
      12 `none`. The discriminator has to be per line, and 3.2 puts it there.
      A digest line written before 3.2 has **no** `evidence` field: treat that as
      unknown, never as a grade. Tests: totals flag mixed grades the way they
      already flag mixed rules; a line with no `evidence` is reported as unknown
      rather than folded into either bucket.

## 4. Make it reachable

- [x] 4.1 Prescribe the dispatch description in `skills/forge/phases/implement.md`
      and both reviewer prompts: reviewers are dispatched with `forge-review final`
      / `forge-review <unit>` — **and in `phases/review.md` and
      `skills/requesting-code-review/SKILL.md`, where the *final* reviewer is
      actually dispatched.** `final` is the only unit the census reads, so a
      prescription that lives only in `implement.md` reaches the wrong dispatch.
      Say plainly that prose is the fallback, and that labelling some reviewers
      but not the final one **refuses** rather than falling back.
      **Verification corrected:** `forge init` renders no skill files — skills
      ship via `forgekit install` — so the original "verify by reading the
      rendered files after `forge init`" was not performable. Verify instead by
      grepping the shipped tree for the literal and by running the matcher
      against the exact strings the docs prescribe.
- [x] 4.2 Document the surface: `session.reviewVerdict` and the digest fields in
      `skills/forge/references/forge-layout.md`, the evidence grades in
      `docs/usage.md` § 13, and a `CHANGELOG.md` entry. Verify the layout table
      against a real `session.json` written by 3.1.

## 6. Attribute the record to the session that made it

- [x] 6.1 The dispatch description carries the Forge session id
      (`forge-review <unit> <forge-session-id>`), and `reviewEvidence` credits a
      record only to the session it names. **Supersedes the window, the sibling
      search and the ledger index** — three attempts at inferring attribution
      from something adjacent to the dispatch, each rejected by an independent
      final review after a self-written review reached the money/auth floor at
      score 93 through it. Removes `notSoleOwner`, the digest `host` field and
      the `now`/`sessionsDir` inputs. Tests: a neighbour's labelled dispatch
      contributes nothing; the same fixture one string different does; a
      dispatch outside the old window still counts when it names this session;
      the old two-word form is unavailable, not absent.
- [x] 6.2 `forge review-label [<unit>]` prints the exact description, defaulting
      to `final`. Measured why: almost no real dispatch record carries the
      label, and of those that do almost none carries a session id (the count is
      kept in `review-census.mjs`, since it moves daily) — a convention that must
      be transcribed is one that is not adopted. Tests: the printed string
      round-trips through the real reader (not a second copy of the pattern);
      the bare command yields `final`; an unreadable unit and an unknown flag
      both fail rather than silently printing the gate-deciding label; a stale
      active session fails loudly rather than printing an unmatchable label.
      Docs updated in `phases/review.md`, `phases/implement.md`,
      `requesting-code-review/SKILL.md`, `final-reviewer-prompt.md` and
      `docs/usage.md`; the e2e fixture uses the new form.

## Split out of this change

`forge review-label` needed to know which session it was labelling, and found
that `.forge/active.json` is written by `forge new` alone — so every command
resolving a session without being told reads a pointer that means *most recently
created*. That includes `forge phase done`, which with two sessions open gates
the wrong one entirely.

Real, worse than the bug this change fixes, and **not this change**. Filed as
`specs/changes/session-resolution/` with the implementation that had already been
written attached as `starting-point.patch`. This change keeps only what it needs:
`review-label` refuses rather than guessing, which is self-contained.

## 5. Product loop

- [x] 5.1 Add e2e steps to `scripts/e2e/harness-portability.mjs` and this change's
      `e2e.json`: build a scratch project with a synthetic sidecar for a
      `forge-review final` dispatch and a review file whose prose contradicts it,
      run `forge phase done`, and assert the verdict follows the evidence and the
      digest froze it. Then delete the transcript and assert the digest is
      unchanged. Verify with a green `forge e2e run`.
