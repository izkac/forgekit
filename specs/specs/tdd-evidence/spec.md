# Tdd Evidence Spec

## Purpose

Describe this capability.

## Requirements

### Requirement: forge tdd run executes and stamps
`forge tdd run --task <nn-slug> --expect fail|pass [--] <cmd…>` SHALL execute
the command itself (repo-root cwd, no shell interpolation) and append
`{cmd, args, expect, exit, ok, startedAt, durationMs}` to
`tasks/<nn-slug>/tdd-runs.jsonl` in the session directory, creating the task
directory when missing. `ok` SHALL be true iff the outcome matches the
expectation (`fail` → non-zero exit, `pass` → zero). A contradicted
expectation SHALL still be stamped (with `ok: false`) and the command SHALL
exit non-zero. Timestamps SHALL be produced by the CLI, never accepted from
the caller.

#### Scenario: Red stamp recorded

- GIVEN a failing test command
- WHEN `forge tdd run --task 01-guard --expect fail -- node --test guard.test.mjs` runs
- THEN it exits zero
- AND the task's `tdd-runs.jsonl` gains a stamp with `expect: "fail"`, non-zero `exit`, `ok: true`

#### Scenario: Contradicted expectation is an audited failure

- GIVEN a passing test command
- WHEN `forge tdd run --task 01-guard --expect fail -- <cmd>` runs
- THEN it exits non-zero
- AND the stamp is appended with `ok: false`

#### Scenario: Green stamp recorded

- GIVEN the test now passes
- WHEN `forge tdd run --task 01-guard --expect pass -- <cmd>` runs
- THEN it exits zero and appends an `ok: true` pass-stamp

### Requirement: Red-before-green pairing gates completion for new sessions
Sessions created by this version SHALL carry `features.tddEvidence: true`.
For such sessions, `forge integrity-check` SHALL fail when any completed task
directory lacks an ok fail-stamp chronologically preceding an ok pass-stamp
in its `tdd-runs.jsonl`. Sessions without the flag SHALL be exempt.

#### Scenario: Valid pair passes

- GIVEN a flagged session whose completed task dir holds an ok fail-stamp older than an ok pass-stamp
- WHEN `forge integrity-check` runs
- THEN the tdd-evidence check passes

#### Scenario: Green without red refuses done

- GIVEN a flagged session whose completed task dir holds only pass-stamps
- WHEN `forge phase done` runs
- THEN the transition is refused naming the task

#### Scenario: Legacy session is exempt

- GIVEN a session without `features.tddEvidence`
- WHEN `forge integrity-check` runs
- THEN the tdd-evidence check is skipped

### Requirement: Tasks with no applicable test cycle have a recorded exemption
A task that changes no behavior (documentation, configuration, wording) has no
red→green cycle to record. `forge evidence` SHALL accept an explicit
`--no-tdd --reason "<text>"` declaration that marks the task dir exempt from
the pairing gate, and `forge integrity-check` SHALL honor it. Without such a
declaration a task directory carrying evidence SHALL remain subject to the
gate. The exemption SHALL be visible to reviewers and recorded in the task's
evidence file — it is a declared judgement, not a silent skip.

#### Scenario: Docs-only task records an exemption and passes

- GIVEN a flagged session and a task that changed only documentation
- WHEN the coordinator runs `forge evidence --task 01-docs --no-tdd --reason "documentation only, no behavior change"` and then `forge integrity-check`
- THEN the tdd-evidence check passes for that task
- AND the recorded reason appears in the task's evidence file

#### Scenario: Evidence without a declaration stays gated

- GIVEN a flagged session and a task dir holding evidence but no exemption and no stamps
- WHEN `forge integrity-check` runs
- THEN the check fails naming the task

### Requirement: Executed stamps count as tier-2 evidence for scoring
`forge score` SHALL count a task directory as carrying tier-2 evidence when it
holds `test-evidence.md` **or** an `ok: true` pass-stamp in `tdd-runs.jsonl`.
A task whose evidence was produced solely by `forge tdd run` SHALL NOT be
scored as missing evidence.

#### Scenario: A red→green task scores as covered

- GIVEN a task dir whose only evidence is a valid red→green `tdd-runs.jsonl`
- WHEN `forge score` runs
- THEN that task counts toward tier-2 evidence coverage
