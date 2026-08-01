# Delta for plan-facts

## ADDED Requirements

### Requirement: Task-group count ignores fences and non-group headings

`collectPlanFacts` SHALL count task groups from `tasks.md` by stripping
fenced code blocks first, then counting only numbered group headings of the
form `## <digits>. …` or `## <digits>) …`. Free-form headings such as
`## Notes` SHALL NOT increment `groups`. A readable tasks.md with checkbox
tasks but no numbered group headings SHALL report `groups: 0` (callers that
need a minimum of one group apply that themselves).

#### Scenario: Notes and fenced headings do not count

- GIVEN a tasks.md with one numbered group, a `## Notes` section, and a
  fenced code block containing a `##` line
- WHEN `collectPlanFacts` runs
- THEN `groups` equals 1

#### Scenario: Headingless plan reports zero groups

- GIVEN a tasks.md with checkbox tasks and no `##` headings
- WHEN `collectPlanFacts` runs
- THEN `groups` equals 0
