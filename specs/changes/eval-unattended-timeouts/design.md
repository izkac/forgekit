# Design — Eval unattended timeouts

## Context

Harbor has no operator. Claude Code ends the trial when the model asks a
question. The Forge workflow still asks for confirmation on implicit design
choices. Campaign agent timeout of 1200s is enough for baseline (~3 min) and
tight for a finished Forge loop (10–22 min wall, two deaths at the cap).

## Decisions

**D1 — Unattended rule on the Forge arm blurb, not the Forge skill.**
The runner already appends an arm section to every staged `instruction.md`.
That is the eval-specific operator. Changing the skill would alter interactive
Forge. If the skill still wins in a later cohort, that is a follow-up.

**D2 — Same 3600s cap on both campaign arms.**
Fairness is one clock. Baseline returns early. 3600s covers a full loop plus
one review-fix round. 2400s would have saved the 1322s deaths but leaves
little room after a slow implement.

**D3 — Bump episode version to 1.1.0.**
Timeout lives in `task.toml`. Silent rewrite of 1.0.0 would mix cohorts.

**D4 — Campaign only.**
hard-v2 stays 1200s. This change exists so the next campaign run is comparable
on finished work, not to retune every corpus.

**D5 — Keep reviews and tests.**
Thinning ceremony would make Forge cheaper, not fairer.

## Risks

- A stuck Forge trial can now burn up to an hour. That is accepted spend for a
  fair loop.
- The unattended sentence may still lose to the Forge skill. Measure on the
  next cohort; do not pre-emptively rewrite the skill.
