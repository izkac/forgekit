# Frontier-round interview for the brainstorm phase

## Why

Forge's brainstorming skill interviews the user one question at a time with no
dependency model, no stop condition beyond "once you believe you understand", no
recommended answers on individual questions, and no mechanism that forces silent
assumptions into the open. Research into current interview-style skills (notably the
mattpocock/skills `grilling` primitive) shows a strictly better engine: frontier
rounds over a design tree, a facts-vs-decisions split, per-question recommendations,
and an explicit "nothing silently assumed" termination rule. The user approved
adopting exactly that set (P1–P4).

## What Changes

- `skills/forge/skills/brainstorming/SKILL.md`: replace the one-question-at-a-time
  interview with frontier rounds (numbered questions, each with a recommended answer,
  dependency-ordered, recomputed per round); add the facts-vs-decisions rule
  (exploration subagents find facts non-blocking, the user only decides); add the
  "all recommended" fast path; add an open-questions/assumptions ledger with an
  empty-ledger termination rule, a mandatory `## Assumptions` design-doc section, and
  a "no silent assumptions" item in the spec self-review.
- `skills/forge/phases/brainstorm.md`: pace line updated to the new depth meanings
  (full = rounds until the frontier is empty; short = ≤2 rounds, rest become
  approved assumptions; minimal = one round, confirm intent).
- `skills/forge/references/pace.md`: `brainstorm.depth` knob descriptions and preset
  matrix row updated to match.

## Capabilities

- `brainstorm-interview`: interview engine of the brainstorm phase — delta at
  `specs/brainstorm-interview/spec.md`

## Impact

Instruction-file (markdown) change only; no CLI code, no config schema change —
`brainstorm.depth` value names are unchanged. Affects every future Forge brainstorm
session on machines that re-run `forgekit install --skills forge --force`
(existing distribution mechanism, out of scope here). The bundled skill is a
maintained fork (see `skills/forge/skills/NOTICE.md`), so diverging further from the
Superpowers upstream is sanctioned.
