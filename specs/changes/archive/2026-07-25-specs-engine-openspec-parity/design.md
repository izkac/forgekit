# Design

## Context

OpenSpec’s full layout is engine-root + main capability catalog + per-change
artefacts including **delta** specs under `changes/<name>/specs/` (not a
folder named `deltas/`). Forge’s built-in engine only scaffolded
`proposal.md` / `tasks.md`, so format claims of “OpenSpec-compatible” were
incomplete and switching trees required moving directories.

## Decisions

- Decision: Match OpenSpec path names exactly (`specs/` for deltas and catalog).
  - Alternatives considered: invent a `deltas/` directory — rejected (breaks
    drop-in reuse of `openspec/` trees and archive-to-adr expectations).
  - Rationale: `plan.dir: openspec` then works as a zero-move switch.
- Decision: Merge deltas on `forge change archive` by default.
  - Alternatives considered: document-only manual sync — rejected for parity
    with `/opsx:archive`.
  - Rationale: agents and operators get the same end state as OpenSpec.
- Decision: `--plan-dir` only applies to the specs engine at init.
  - OpenSpec keeps its vendor root; recording `plan.dir` for openspec is
    optional and unused by the vendor CLI today.

## Risks / Trade-offs

- Markdown merge of MODIFIED/REMOVED is title-based (`### Requirement: …`) —
  unusual formatting in deltas may need hand-fix; `--no-sync` is the escape.
- Global `forge` installs stay stale until republish / `forgekit install --update`.
