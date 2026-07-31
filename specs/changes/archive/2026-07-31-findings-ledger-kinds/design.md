# Design — findings-ledger-kinds

## Context

W1 of the convergence plan audited F11/F18/F19/F51 against the shipped F12
stamp. F18 and F19 closed; F11 stays (pace / `THOROUGH_RE`, not census); F51
kept as below-floor residual. The remaining structural defects are
bookkeeping: one queue, severity default, no links, reopen-as-prose.

## Decisions

### D1 — Five kinds, required on add

`KINDS = ['bug', 'debt', 'tradeoff', 'idea', 'process']`.

| kind | Meaning |
| --- | --- |
| bug | Defect true right now; wrong if a user hit it |
| debt | Works, costs more to maintain than it should |
| tradeoff | Deliberate decision recorded so it is not rediscovered as a bug |
| idea | Improvement that fixes nothing broken |
| process | Lesson about how to work, not about the code |

No default. A default is what produced "24 of 26 major."

### D2 — Severity required (no `major` default)

Same rationale. Agents read the error; humans filing by hand can too.
`SEVERITIES` unchanged: `blocker | major | minor | note`.

### D3 — List and status filter to bugs

`list` without `--all-kinds` shows open bugs (still respects `--all` for
resolved). Footer: `N non-bug opens hidden; forge finding list --all-kinds`.
`openFindings.count` = open bugs; `byKind` is a full tally of open rows.

### D4 — dependsOn, surface on resolve, never auto-close

Dependent may survive its root cause with reduced scope (F11 case). Resolve
prints dependents and exits 0. `link` mutates an existing open finding.

### D5 — Structured reopen + gate at reopenCount ≥ 2

`reopen` moves resolved → open, increments `reopenCount`, sets `reopenedFrom`.
List prefix e.g. `↻2`. Status field `reopenedFindings` separate from the
count. Gate: if any open finding with `reopenCount >= 2` has `change`
matching the session's openspec change (or text/slug match), `phase done`
refuses unless `--reopen-waived` (mirror final-review waiver shape). Keep the
gate narrow — subject match via `change` field first; do not invent NLP.

### D6 — Backfill by reading, not regex

Classify all existing rows. Open ones have strong textual signals. Script
under `scripts/`, run once, delete. Record before/after counts in the commit
message. Ledger is gitignored — the code + tests are what ship.

## Alternatives rejected

- Default severity to `minor` — understatement hides real majors; required is
  clearer for agents.
- Auto-resolve dependents — F11 proves a dependent can remain after the root
  fix with residual scope.
- Bundle W5–W7 — independent; widens review surface past one group cycle.

## Risks

- Agents that currently omit `--severity` will start failing until prompts /
  skill docs update (W7). Mitigate: error text names both required flags and
  the five kinds.
- Reopen gate false positives if `change` is null — only fire when `change`
  equals the session's change slug (or explicit `--change` match); skip
  unmatched rather than block everything.
