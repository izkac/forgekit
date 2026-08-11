# Recalibrate triage and review cadence

## Why

Forge exists to stop agents cutting corners. Reviews are the expensive part of
that, and measured against 87 recorded sessions across forgekit, helm and volo,
the ceremony is mispriced in three ways.

**The skip path is unreachable.** `references/substantial-work.md` gates entry
on **ANY** of seven broad conditions and gates skipping on **ALL** of three that
cannot be simultaneously true — a pure question is not also a typo fix, and the
third condition already requires the manual `/forge:skip` escape hatch. The same
file then contradicts itself: *"If no → execute directly. Skip requires explicit
user opt-out."* The classifier matches the doc: `isSubstantialWork` fires on a
prompt's opening verb, so "update the changelog" is substantial. Across 87
sessions, none was ever marked skipped.

**Per-task review has no measured yield.** From Forge's own review stamps
(harvested `subagentsDispatched` is excluded — it is `null` for 2 of the 87
rows and `0` for 22 more, and a harvested zero cannot be told apart from a
session that genuinely dispatched nothing; see `baseline-yield.md`):

| Pace | Sessions | Tasks | Independent reviews | Reviews/task | Rejections | Rejections/100 tasks |
| --- | --- | --- | --- | --- | --- | --- |
| brisk | 7 | 44 | 3 | 0.07 | 0 | 0.0 |
| standard | 22 | 187 | 24 | 0.13 | 9 | 4.8 |
| thorough | 54 | 717 | 260 | 0.36 | 34 | 4.7 |

Thorough spends 2.8x the reviews per task and finds the same number of problems
per unit of work.

**Pace only ratchets up.** Triage and pace resolve at prompt time from the
opening verb, before task count, capability count or risk are known, with a
documented posture of erring toward Forge. Nothing reconsiders afterwards:
`set-phase.mjs:173` escalates at ≥15 tasks and there is no inverse. The one
counter-example is the pattern to generalize — `plan-facts.mjs` already resolves
`resolvedCeremony: combined` at plan time from real evidence.

## What Changes

- **Skip gate corrected** — `ALL` becomes `ANY` in the skip conditions, the
  self-contradicting closing line is removed, and the prompt classifier's
  trivial detection widens to match, keeping "err toward Forge when genuinely
  unsure" for everything else.
- **Plan-time exit ramp** — after brainstorm, a change resolving to a small,
  single-capability, non-high-risk, spine-free shape offers to leave Forge
  instead of producing proposal, design, tasks, spine and brief for a two-file
  edit.
- **Review matrix re-cut** — thorough drops per-task review to per-group and
  keeps its meaning through depth and fix rounds; lite and brisk gain the final
  review; lite's `maxRounds` goes 0 → 1 so that review can request a fix. The
  high-risk hard floor is untouched — money, auth, shared contracts, migrations
  and secrets still get an immediate per-task review at every pace.
- **Two-way pace** — plan-time evidence may lower the resolved pace as well as
  raise it, on the same signals escalation already uses. A user-pinned pace is
  never overridden in either direction.
- **Yield measurement** — `forge analyze` gains the per-pace review-yield table,
  and the pre-change baseline is recorded in this change directory so the effect
  is checkable rather than felt.

## Capabilities

- `pace-signals`: skip-gate logic, trivial classification, the preset matrix,
  two-way resolution — delta at `specs/pace-signals/spec.md`
- `review-evidence`: review-yield reporting and the recorded baseline — delta at
  `specs/review-evidence/spec.md`
- `session-lifecycle`: the plan-time exit ramp and how a session leaves Forge
  after brainstorm — delta at `specs/session-lifecycle/spec.md`

## Impact

Affected code: `packages/cli/src/preferences.defaults.json`,
`preferences.mjs`, `triage-prompt.mjs`, `set-phase.mjs`, `plan-facts.mjs`,
`analyze.mjs`, `score.mjs` (its escalation expectation at line 578), and the
skill docs `skills/forge/references/substantial-work.md`,
`references/pace.md`, `phases/brainstorm.md`.

Risks:

- **Lowering ceremony could reduce catch rate in ways rejections do not
  capture.** A problem nobody looked for produces no rejection anywhere. The
  guardrail detects a fall in problems found, not a rise in problems missed.
  Recorded as a known limit rather than solved here.
- **`score.mjs` encodes the current escalation expectation**, so scoring must
  move with the resolution rules or previously-good sessions start failing.
- **Skill docs ship to installed skills.** Doc changes need
  `forgekit install --skills forge --force` to reach other machines and take
  effect there.
- **The evidence base mixes three projects and two pace-matrix revisions.** The
  direction is clear; the exact magnitudes are not preregistered.

Reversible: every behavioural change is a preset value or a resolution rule, and
the baseline recorded here makes reverting a measured decision rather than a
retreat.
