# Architecture Decision Records

Distilled "why" behind decisions that future code must respect. The verbose
record stays in the archived change under `specs/changes/archive/`; an ADR is
the one-page version a maintainer reads before proposing to undo it.

Written by the `archive-to-adr` skill when a change is archived. Configured in
`.forge/config.json` → `adr`.

| # | Decision | Status | Date | Area |
|---|----------|--------|------|------|
| [0001](0001-harness-prerequisites-are-recorded-not-detected.md) | Harness prerequisites are recorded, not detected | Accepted | 2026-07-26 | e2e harness / runtime integrity |
| [0002](0002-plan-tasks-md-is-progress-source-of-truth.md) | Plan `tasks.md` checkboxes are progress source of truth | Accepted | 2026-07-27 | session / fleet / health |

## When to write one

A change earns an ADR when it establishes or revises a boundary, picks one
approach over a real alternative, introduces a constraint future code must
respect, commits to a vendor/protocol/library that is expensive to swap, or
codifies a repo-wide convention. Implementation detail inside an existing
decision does not.

Non-architectural archives get a single line in their `proposal.md` instead:

```text
No ADR — non-architectural change
```

## Format

`NNNN-short-topic.md`, numbered sequentially, never reused. Sections: Status /
Date / Area / Related, then Context, Decision, Alternatives considered,
Consequences (Positive / Negative / Neutral), References.
