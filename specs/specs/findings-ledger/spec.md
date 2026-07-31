# Findings Ledger Spec

## Purpose

Describe this capability.

## Requirements

### Requirement: Finding kind is required and enumerated
(Documentation consumers) Agent-facing docs SHALL instruct that `--kind` and
`--severity` are required on `forge finding add`, and SHALL state the
guardrails: fix beats file; re-check dependents on resolve; never narrow a
heuristic without a measured corpus.

### Requirement: Finding severity is required
The system SHALL require `--severity` on `forge finding add` (values
`blocker | major | minor | note`). The system SHALL NOT default severity
to `major` or any other value.

#### Scenario: Add without severity is refused
- GIVEN a project with a findings ledger
- WHEN `forge finding add "debt note" --kind debt` runs with no `--severity`
- THEN the command exits non-zero and no row is written

### Requirement: Open-bug is the default list and status headline
`forge finding list` (without `--all-kinds`) SHALL show only open findings
of kind `bug` (and, when `--all` is passed, resolved bugs as today for the
all toggle). It SHALL print a footer stating how many open non-bug findings
are hidden and that `--all-kinds` reveals them. `forge status` JSON
`openFindings.count` SHALL equal the number of open bugs. `openFindings.byKind`
SHALL report open counts for every kind.

#### Scenario: List hides non-bugs by default
- GIVEN one open bug and one open debt finding
- WHEN `forge finding list` runs
- THEN only the bug row is printed
- AND the footer mentions `1` non-bug open hidden and `--all-kinds`

#### Scenario: Status counts bugs only
- GIVEN one open bug, one open idea, and one open process finding
- WHEN `forge status` JSON is read
- THEN `openFindings.count` is `1`
- AND `openFindings.byKind.bug` is `1`
- AND `openFindings.byKind.idea` is `1`
- AND `openFindings.byKind.process` is `1`

### Requirement: Findings may declare dependsOn
A finding MAY carry `dependsOn: string[]` of other finding ids. `forge
finding add` SHALL accept `--depends-on` as a comma-separated id list.
`forge finding link <id> --depends-on <ids>` SHALL add edges to an
existing finding without duplicating ids. Linking to an unknown id SHALL
fail.

#### Scenario: Resolve surfaces open dependents
- GIVEN open finding F20 with `dependsOn: ["F10"]` and open F10
- WHEN `forge finding resolve F10 --note "fixed"` runs
- THEN F10 is resolved
- AND stderr includes a `Re-check these — their root cause just closed:`
  section naming F20 (stdout remains the JSON payload for machine consumers)
- AND F20 remains `open`
- AND the command exits 0

### Requirement: Reopened findings are structured and loud
The system SHALL provide `forge finding reopen <id> --from <oldId> --note
"…"` that moves a resolved finding to `open`, sets `reopenedFrom`, and
increments `reopenCount`. List output SHALL sort findings with
`reopenCount >= 1` before other open bugs and mark the reopen count.
`forge status` SHALL expose `reopenedFindings` naming each such open
finding. Reopening an already-open finding SHALL fail.

#### Scenario: Second reopen increments count
- GIVEN resolved finding F11 with `reopenCount: 1`
- WHEN `forge finding reopen F11 --from F3 --note "regressed again"` runs
- THEN F11 is `open` with `reopenCount: 2`

### Requirement: Double-reopened findings can block phase done
When `forge phase done` runs for a session whose change slug equals an
open finding's `change` field and that finding has `reopenCount >= 2`,
the system SHALL refuse the transition unless `--reopen-waived` is
passed. Findings with `reopenCount < 2` or a non-matching `change` SHALL
NOT trigger this gate.

#### Scenario: reopenCount 2 blocks done
- GIVEN session change slug `fix-parser` and open finding F11 with
  `change: "fix-parser"` and `reopenCount: 2`
- WHEN `forge phase done` runs without `--reopen-waived`
- THEN the command exits non-zero and names F11

#### Scenario: Waiver allows done
- GIVEN the same session and finding
- WHEN `forge phase done --reopen-waived` runs
- THEN the reopen gate does not refuse (other gates may still apply)

### Requirement: Related open bugs surface on session create
When `forge new <slug>` creates a session, the system SHALL include open
findings of kind `bug` whose `change` equals the slug or whose `change`/`text`
matches a slug token of length at least 4. The result SHALL appear as
`relatedFindings` on the command's JSON output. Session creation SHALL NOT
fail because related findings exist.

#### Scenario: Matching bug is listed
- GIVEN an open bug with `change: "fix-parser"`
- WHEN `forge new fix-parser` runs
- THEN the JSON includes that finding under `relatedFindings`
- AND the session is created successfully

### Requirement: Stale open bugs appear on status
`forge status` JSON SHALL include `staleFindings`: open bugs whose
`createdAt` is more than 7 days before now, each with `id`, `ageDays`, and
`text`.

#### Scenario: Seven-day-old bug is stale
- GIVEN an open bug with `createdAt` eight days ago
- WHEN `forge status` runs
- THEN `staleFindings` contains that finding with `ageDays` ≥ 7
