# Findings Ledger Spec

## Purpose

Describe this capability.

## Requirements

### Requirement: Finding kind is required and enumerated
The system SHALL require every new finding to carry a `kind` drawn from
exactly `bug`, `debt`, `tradeoff`, `idea`, `process`. Adding a finding
without `--kind`, or with an unknown kind, SHALL fail with an error that
names the five allowed values. The system SHALL NOT default `kind`.

#### Scenario: Add without kind is refused
- GIVEN a project with a findings ledger
- WHEN `forge finding add "something broke" --severity major` runs with no `--kind`
- THEN the command exits non-zero and the error text lists `bug`, `debt`, `tradeoff`, `idea`, `process`
- AND no new ledger row is written

#### Scenario: Add with kind persists it
- GIVEN a project with a findings ledger
- WHEN `forge finding add "null deref in parse" --kind bug --severity major` runs
- THEN a new open finding is written with `kind: "bug"` and `severity: "major"`

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
