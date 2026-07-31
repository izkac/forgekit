# Design

## Context

`reviewCensus` grades the final-review verdict `host` (the host's own
sidecar record of a dispatch labelled `forge-review final <session-id>`),
falling back to `inferred` (prose). The `recorded` grade has been reserved
since rule 4 for "a signed attestation not yet produced by anything". The
host record prunes in days; the prose is text written by the party being
judged. F12 (twice reopened) and F58 (the pruned-transcript residual)
prescribe a stamp written by Forge at dispatch time, into the session's own
tree, read back by the census.

Brainstorm artefacts:
`.forge/sessions/20260731T105409Z-review-stamp-at-dispatch-92570a/brainstorm/`.

## Decisions

- **D1 — `forge review-label` writes the stamp.**
  - Alternatives: a new `forge review-dispatch` command (cleaner separation,
    but every doc and prompt mandating `review-label` would need rewriting,
    and two commands would compete for the same moment); a dispatch stamp
    plus a completion amendment (strongest record, but a second forgettable
    step — this subsystem has measured that partial adoption is worse than
    none).
  - Rationale: `review-label` already runs at exactly dispatch time, is
    mandated by a HARD-GATE, and refuses on session ambiguity. Adoption
    comes free. The stamp records the model resolved in-process via
    `resolveModel()` (tier `capable` by default, `--tier` to override) —
    F12's "model + agent id from forge resolve-model".

- **D2 — the stamp decides the gate when the host cannot answer.**
  - Alternative: grade-only (`recorded` replaces `inferred` in ledgers, gate
    still demands host evidence or a waiver). Safer against a coordinator
    who stamps without dispatching, but leaves F58's residual open: a
    genuine reviewer in a pruned transcript still fails the gate — refusing
    correct work, the failure this subsystem has been reverted for twice.
  - Rationale: user-approved. Over-credit is the subsystem's chosen error
    direction; host evidence still overrides whenever it can answer.

- **D3 — the stamp never answers on the below-substance-floor branch.**
  - Alternative: stamp answers every `hostFinalReview` null. But the forger
    runs `review-label` anyway (that is where the label comes from), so the
    stamp would resurrect the one-request forgery review-dispatch-substance
    killed: token dispatch → below floor → null → stamp says independent.
  - Rationale: *the stamp substitutes for a record the host lost, never for
    work the reviewer didn't do.* A well-formed `final` bucket below the
    floor means the host measured the dispatch and found no work — that
    branch keeps routing to prose. Mechanically: the adoption-gate null
    (`prescribed === 0`) implies an empty `units`, so "host evidence has a
    well-formed `final` bucket" isolates exactly the below-floor branch
    among the null reasons; a *malformed* bucket is not well-formed, and the
    stamp may answer there (same over-credit direction as the prose that
    branch falls to today).

- **D4 — a partial binding's confident negative does not outrank the stamp**
  (added 2026-07-31, user-approved, after task 3.2's reviewer reproduced the
  gap). The host's genuine-negative branch (`final` unit absent from the
  record) is only as complete as the binding it was measured from: a session
  bound to two host transcripts whose older half — the one the reviewer ran
  in — has been pruned still yields `available: true` from the surviving
  half, and that negative refused a genuinely reviewed session with the
  stamp never consulted. The exact confidently-wrong answer F58 describes.
  - Mechanism: `reviewEvidence` reports `partial: true` when some bound
    session ids resolved to no transcript on disk (it already refuses
    entirely on *unreadable* ones — F27 — and on *all* pruned —
    `bound.length === 0`); `hostFinalReview` marks the absence-negative as
    distinct from the measured-stop negative; the census lets a valid stamp
    override only the absence-negative, and only under a partial binding.
  - Boundaries that hold: a measured stop always wins (a real record of the
    operator declining); a complete binding's negative always wins (the
    host saw everything — a printed label with no dispatch is not a
    review); the below-substance-floor branch is untouched (D3).
  - Alternative rejected: reporting the whole answer unavailable on any
    partial binding — the evidence module's own comment rejects it twice;
    it would blind every resumed session within days. `reviews/dispatches.json` in the session
  directory: `{ version: 1, stamps: [{ unit, label, sessionId, at,
  model: { tier, model, omitModel, billing, agent } }] }`, append-only.
  Read/write live in one new module (`review-stamp.mjs`) so the CLI writer
  and the census reader cannot drift. The census additionally requires
  `stamp.sessionId === basename(sessionDir)` — a copied file must not
  credit a different session. It sits under `sessionDir`, which
  `reviewCensus` already receives, so no caller wiring changes; and it is
  read fresh from disk on every pass, so a `finish`-then-`done` remeasure
  reproduces the verdict without widening `freezeReviewVerdict`'s keep-rule.

- **Stamping never blocks the label.** Write failures warn on stderr and the
  label still prints; a lost stamp degrades to today's behaviour. Stdout
  stays byte-identical — existing consumers parse it.

## Risks / Trade-offs

- **Stamped-then-declined, host pruned** → over-credits. Accepted with D2;
  `--final-review-waived` remains the prescribed record for a declined
  reviewer, and the host record, while it survives, surfaces the stop and
  overrides the stamp.
- **A review file honestly declaring `self-check` beside a stamp, host
  gone** → the declaration is not read. A triple coincidence (stamp +
  decline + prune), and the same "never consult the file under suspicion"
  doctrine the host path already enforces with pinned tests.
- **The stamp is not a security boundary** — a coordinator can run
  `review-label` and dispatch nothing. Neither is the host record (a token
  dispatch is cheap) nor the floor ("a forger who reads this can pad to
  five"). The threat model is ambiguity and evidence loss, not a determined
  liar; the stamp is strictly stronger than the prose it displaces because
  it is written by a command at a moment in the flow, not parsed from the
  judged party's text after the fact.
- **Traffic shift**: sessions that stamp stop exercising the prose rules;
  unstamped legacy sessions are byte-identical to today. F51 pressure
  shrinks; F11/F18/F19 stay open for the legacy path.
