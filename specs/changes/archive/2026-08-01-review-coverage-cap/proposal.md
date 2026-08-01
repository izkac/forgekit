# Review coverage caps the grade

## Why

Review depth is **5 points of ~100** in `forge score`. It cannot move a grade,
which means the scorecard — the record that outlives session cleanup — says
nothing consequential about whether anyone other than the author read the work.

Measured on this project's own 18-session history (`.forge/sessions.jsonl`):

| Session | Pace | Grade | Independent per-group reviews |
| ------- | ---- | ----- | ----------------------------- |
| `sync-tasks-md-progress` | standard | **97 / A** | 0 (3 self-checks) |
| `harness-setup-probe` | standard | **94 / A** | 0 (no review artifacts) |
| `session-resolution` | **thorough** | **90 / A** | 0 (no review artifacts) |

`thorough` prescribes a reviewer after **every task**; `standard` one per
**group** (`references/pace.md`). All three sessions were graded A while
dispatching no per-group reviewer at all. `session-resolution`'s final-review
verdict is additionally graded `inferred` — read off prose in a file written by
the party being judged.

This is finding **F13**, reopened from F10. A previous attempt (0.3.25) was
reverted in 0.3.26 for being **backwards**: its guard read `reviewUnits`, a
variable assigned only inside the else-branch of the no-reviews case, so a
session with ZERO reviews kept `0`, failed the `>= 3` guard and scored 95/A
uncapped — while a session with one independent review of six groups capped at
69/C. The cap that existed because "nobody outside the author read this" gave
full marks to exactly that session.

F13 states the constraints on any replacement: it must be driven by the census
directly rather than by a variable the no-review path skips, and must be tested
with a zero-review fixture as the **first** case. Both are honored here.

## What Changes

- `forge score` gains a **review-coverage cap** with two tiers, both keyed on
  `census.independent` — a field `reviewCensus` initialises to `0` at
  construction and returns on every path, including the one where no review
  files exist:

  | Condition | Cap |
  | --------- | --- |
  | `independent === 0` and `finalReview !== 'independent'` | 69 (C) |
  | `independent === 0` and `finalReview === 'independent'` | 89 (B) |
  | `independent > 0` | no cap |

- The cap fires **only where reviewers were prescribed**: the effective
  `review.perTask` knob is `always` or `per-group`, and there are at least 5
  planned tasks. `brisk` and `lite` (and an explicit `review.perTask` override)
  are told to skip reviewers and are never capped for obeying.

- The cap reads the **same merged census object** the high-risk cap already
  reads — live census with the frozen verdict layered over it — so the cap and
  the `forge phase done` gate cannot reach different answers.

- No group denominator is involved. Both tiers ask whether *any* independent
  reviewer was dispatched, which needs no denominator, so this does not inherit
  finding F16.

## Capabilities

- `review-evidence`: prescribed review coverage that never happened caps the
  grade — delta at `specs/review-evidence/spec.md`

## Impact

**Code:** `packages/cli/src/score.mjs` (one new pure function plus its call
site), `packages/cli/src/score.test.mjs` (new tests).

**Grades:** three historical sessions would move A→B (94→89, 97→89, 90→89).
Scores in `.forge/scorecards.jsonl` are not rewritten retroactively; only
sessions scored after this ships are affected.

**Risk — accepted, recorded in design.md:** per-group `independent` counts are
prose-classified by design. A prose misread that deflates a real reviewer to a
self-check now costs a grade where it previously cost 2 points. A cap costs a
grade and never a transition, which is the error direction this subsystem has
twice been reverted for getting wrong in the other direction.

**Not in scope:** F16 (group denominator defects — the cap does not use the
denominator), F14 (caps array does not distinguish applied from noted — this
change follows the existing shape).
