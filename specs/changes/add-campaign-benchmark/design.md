# Design — campaign benchmark

## Context

`forgekit-held-out-v1` and `forgekit-hard-v2` both measure single-shot work: one
instruction, one agent, one hidden grader, one bit of outcome. Measured results
show 47 ties in 54 pairs. The ties are not a measurement bug — on the ceiling
tasks both arms genuinely meet every requirement.

Forge's claims are about what survives a handoff: specs that outlive the
session, tests that were actually run red then green, a spine recording which
capability is wired to which runtime owner, and a refusal to report false
success. None of those are exercised when the task starts and ends inside one
context window.

## The campaign shape

A **campaign** is an ordered list of **episodes** over one repository.

```
episode 1 ──┬─> repo state A ──> episode 2 ──> repo state B ──> … ──> episode 6
            │
      fresh agent,            fresh agent,
      no memory               no memory
```

Each episode runs a fresh agent container. The agent inherits the repository
the previous episode left behind and nothing else — no transcript, no summary,
no memory. The Forge arm inherits `.forge/` and any specs and tests written
into the repo; the baseline arm inherits whatever it happened to write. That
asymmetry is the treatment, not a confound.

Both arms run the same six episodes on their own independent copy of the repo.

## Decisions

### D1 — Fresh agent per episode, not one continuous session

**Chosen:** a new agent container per episode.

**Alternatives:** one continuous session across all six; both as separate
conditions; fresh agent plus a handoff summary.

A continuous session measures context rot — the model degrading as the
conversation grows — which is a model property Forge does not claim to fix. A
handoff summary would measure how much each arm writes, not whether what it
wrote is useful. Fresh-agent-per-episode isolates exactly one thing: whether
the artefacts left in the repository let a stranger continue the work.

### D2 — Carryover only, no clean-repo control arm

**Chosen:** each arm builds on its own previous output, two repetitions for
first-position counterbalancing.

**Alternative:** additionally run every episode from an identical clean
reference repo, so per-episode difficulty can be separated from accumulated
damage.

The control would cost double (~$76 / ~8h against ~$38 / ~4h). The confound it
removes — "Forge's episode 5 started from healthier code" — is the effect being
claimed, not noise. If the pilot shows a widening gap and the attribution is
challenged, the control arm becomes a follow-up change.

### D3 — Counted rewards, not a richer outcome bit

**Chosen:** rewards carry `requirements_met` / `requirements_total` and
`regression_met` / `regression_total`, keeping `shippable` derived as before.

Counts are what make a widening gap visible. A campaign where the baseline
holds 12 of 14 earlier requirements at episode 4 and 8 of 20 at episode 6 is
the result; two zeros are not.

`shippable` stays defined exactly as today (every required binary outcome
passing) so the aggregator's existing primary endpoint keeps working and
cross-corpus comparison stays meaningful.

### D4 — Blockers are a file, not a sentence

**Chosen:** episodes instruct the agent to write `BLOCKED.md` at the repository
root, naming both conflicting requirements, when a requirement cannot be met
without breaking an existing one. Graders read that file.

**Alternative:** read the agent's final message.

The existing contract is explicit that the final message is process evidence
and never the outcome oracle. A file keeps trap episodes mechanically gradeable
without breaking that rule, and it is equally available to both arms.

`false_completion` follows from it mechanically:

```
false_completion = 1 when the trial ended normally
                   AND requirements_met < requirements_total
                   AND no BLOCKED.md was written
```

No prose is parsed, and an agent that correctly reports being blocked is not
punished for the requirements it could not meet.

### D5 — Hidden tests drive the HTTP entrypoint only

**Chosen:** grader checks issue HTTP requests against the service. They never
import an internal module.

This gives wiring coverage for free. A capability implemented in a file but
never routed fails on its own, with no separate reachability metric and no
extra grader surface to keep honest. It also makes the graders resilient to
episode 5's refactor, which is allowed to move every internal module.

### D6 — A new domain, not a grown hard-v2 task

**Chosen:** a new Node 22 order/payment service.

Money plus a status state machine gives invariants that span endpoints, which
is what lets a later episode damage an earlier one. Reusing a hard-v2 app would
save writing but inherits public, possibly contaminated content and graders
built for a single-shot shape.

## Episode spine

Ordered so that each episode can damage its predecessors.

| # | Request | Probes |
| --- | --- | --- |
| 1 | Orders, charging, status machine (pending → paid → shipped → delivered, plus cancelled) | Baseline; establishes the invariants |
| 2 | Partial refunds against the episode 1 ledger | Ordinary build-on-top work |
| 3 | **Trap:** "refunds may be issued on cancelled orders", contradicting episode 1's rule that cancelled is terminal and moves no money | Flag the clash via `BLOCKED.md`, or silently pick one and poison every later episode |
| 4 | Idempotency keys on every mutating endpoint | Cross-cutting; touches every route from episodes 1–3 |
| 5 | **Refactor:** split handlers into modules, behaviour unchanged | The operation agents are measurably worst at (CodeScene: 30–37% of LLM refactors functionally correct) |
| 6 | **Trap:** auto-expire stale orders after 30 days | The obvious implementation expires already-paid orders, breaking episode 1's terminal states — specified but never directly tested |

Episode 3 is scored as met when `BLOCKED.md` names both conflicting
requirements and the pre-existing terminal-state behaviour is unchanged.
Silently implementing either reading scores it unmet.

## State carryover

The runner copies the previous episode's `/app` output into the next episode's
agent environment. This is the highest-risk mechanism in the change: a carry
step that silently fails turns every episode into a fresh start, which would
still produce plausible-looking results.

Two protections:

1. **Carryover is verified, not assumed.** Each episode after the first runs a
   grader precondition asserting that a marker written by the previous episode
   is present. A missing marker is an operational failure, not a zero score, so
   it lands in `incomplete_pairs` rather than being read as a result.
2. **Verifier isolation is unchanged.** `tests/` is never carried, never
   mounted into an agent container, and never inherited between episodes. Only
   `/app` carries.

## Risks

- **Reward schema change reaches existing corpora.** Normalization must keep
  accepting current hard-v2 rewards unchanged, and `corpus-v1.lock.json` must
  still pass byte-for-byte.
- **Effect may not appear.** Six episodes may be too few, and episode 3's
  contradiction may be too plainly stated. Both accepted; recorded in the
  session's `brainstorm/decisions.md`.
- **Public corpus.** Contamination cannot be excluded, same as hard-v2.
- **Cost of a real run is separate authorization.** Building the corpus is not
  evidence; only an authorized, preregistered cohort is.
