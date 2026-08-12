# Pre-change yield baseline

Measured: **2026-08-11**. These figures are the pre-change reference for the
review-cadence rules this change alters (see `design.md` D5). They are
`measured: I ran the shapes below myself` against the checked-in ledgers
listed below — not copied from `proposal.md`.

## Source ledgers

Newline-delimited JSON, one row per Forge session:

| Ledger path | Sessions contributed |
| --- | --- |
| `/home/iztok/Projects/forgekit/.forge/sessions.jsonl` | 44 |
| `/home/iztok/Projects/helm/.forge/sessions.jsonl` | 41 |
| `/home/iztok/Projects/volo/.forge/sessions.jsonl` | 2 |
| **Total** | **87** |

## Method

- Grouped rows by the `pace` field.
- **Sessions** = row count per pace group.
- **Tasks** = sum of the total side of each row's `tasks` field
  (`"<complete>/<total>"` — the `<total>` half).
- **Independent reviews** = sum of `reviews.independent`.
- **Reviews/task** = independent reviews ÷ tasks.
- **Rejections** = sum of `reviews.rejections`.
- **Rejections/100 tasks** = rejections ÷ tasks × 100.
- `reviews.total` and `reviews.selfChecks` were read but not used in this
  table (self-checks are not independent review dispatches).
- `subagentsDispatched` is **excluded** from this table: it is missing (JSON
  `null`) for 2 of the 87 rows across all three ledgers, so a sum over it
  would silently undercount rather than report zero for those sessions. Both
  null rows are in the forgekit ledger.
- Arithmetic was done with a throwaway script (`/tmp/baseline-yield.py`, not
  checked into the repo) reading the three ledger paths above.

## Result

| Pace | Sessions | Tasks | Independent reviews | Reviews/task | Rejections | Rejections/100 tasks |
| --- | --- | --- | --- | --- | --- | --- |
| brisk | 7 | 44 | 3 | 0.07 | 0 | 0.0 |
| standard | 26 | 187 | 24 | 0.13 | 9 | 4.8 |
| thorough | 54 | 717 | 260 | 0.36 | 34 | 4.7 |

All 87 sessions across the three ledgers carry a `brisk`, `standard`, or
`thorough` `pace` value; no row fell outside these three groups.

## Agreement with `proposal.md`

`proposal.md`'s table is explicitly an earlier harvest (`assumed — verify`),
not a target. Comparing:

- **Tasks, independent reviews, reviews/task, rejections, rejections/100
  tasks** — identical to the proposal's table for all three paces.
- **Standard sessions** — this measurement finds **26**, not the proposal's
  22. The ledgers have grown since the proposal's harvest (new sessions land
  in `sessions.jsonl` as work continues), so a later count over the same
  files can differ from an earlier one; task/review/rejection totals for
  `standard` matching exactly suggests the extra 4 sessions were open or
  produced 0 tasks and 0 reviews, not that the two harvests used different
  ledgers or a different method.
- **`subagentsDispatched` null count** — this measurement finds **2 of 87**
  rows null (both in the forgekit ledger), not the proposal's "29 of 44
  forgekit sessions". This is a real disagreement, not a rounding
  difference. The proposal's claim does not match the current forgekit
  ledger's `subagentsDispatched` field as it stands on 2026-08-11. Recorded
  here rather than silently reconciled, per this task's instruction not to
  bend the method to match the proposal.
