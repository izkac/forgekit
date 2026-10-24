# Delta for Escape Tracking

## ADDED Requirements

### Requirement: Outside-plan flag on Escape candidates
Each Escape candidate SHALL carry `outsidePlan`: the subset of its hit files whose basename appears in
none of the change's own plan documents — the files under the plan-engine directory that the Commit
range adds or modifies, read at the range head. When the range holds no plan documents, `outsidePlan`
SHALL be empty. The flag SHALL NOT hide, reorder or change any candidate. `forge escapes [list]` and the
interactive prompt SHALL print the flagged files as a possible sweep (F16).

#### Scenario: A swept-in file is flagged
- GIVEN a done session whose plan names `src/a.js` and whose range also added lines to `notes.md`
- WHEN later commits within 14 days rewrite a line of each file
- THEN both commits are listed, the `notes.md` one with `outsidePlan: ["notes.md"]`, the `src/a.js` one with `outsidePlan: []`

#### Scenario: No plan documents, no flag
- GIVEN a done session whose range holds no plan-engine files
- WHEN a later commit rewrites one of its lines
- THEN the candidate is listed with `outsidePlan: []`

## MODIFIED Requirements

### Requirement: Escape rate over time across the fleet
`forge escapes report [--json]` SHALL report, per month of done and per pace, the number of done
sessions, the number with at least one confirmed Escape, their ratio (the Escape rate) and how many
sessions still have an open 14-day window, plus the same four figures in total, aggregated over this
project and every fleet registry project still on disk, deduped by session id. A session's pace SHALL
be the one recorded for it at done (its `sessions.jsonl` row, else its fleet registry entry), or
`unknown` when none was recorded. Paces SHALL be ordered thorough, standard, brisk, lite, then any other
recorded value, with `unknown` last.

#### Scenario: Rate per month
- GIVEN two done sessions in October, one with a confirmed Escape
- WHEN `forge escapes report --json` runs
- THEN October shows done 2, escaped 1, rate 0.5

#### Scenario: Rate per pace
- GIVEN done sessions at standard (two, one with a confirmed Escape), brisk (one) and one with no recorded pace
- WHEN `forge escapes report --json` runs
- THEN `byPace` lists standard done 2 escaped 1 rate 0.5, brisk done 1 rate 0, unknown done 1, in that order
