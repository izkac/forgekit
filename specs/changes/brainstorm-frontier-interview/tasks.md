# Tasks

## 1. Brainstorming skill rewrite

- [x] 1.1 Rewrite the interview engine in `skills/forge/skills/brainstorming/SKILL.md`:
      frontier rounds with the ❓/➡️ round format, facts-vs-decisions rule,
      "all recommended" fast path, ledger + `## Assumptions` design section,
      empty-frontier+empty-ledger termination, self-review check 5 (no silent
      assumptions). Keep hard gate, anti-pattern, decomposition, approaches,
      sectional presentation, user gate, visual questions, terminal state.
      Verify: file states the frontier definition, round format, fast path, and
      termination rule; `grep -i "one question"` returns nothing in the file.

## 2. Pace wiring

- [x] 2.1 Update the pace line in `skills/forge/phases/brainstorm.md` to the new
      `brainstorm.depth` meanings. Verify: line references rounds, not option counts
      alone.
- [x] 2.2 Update `skills/forge/references/pace.md`: preset matrix `brainstorm.depth`
      row and the `### brainstorm.depth` knob section. Verify: descriptions match
      design decision 5.

## 3. Consistency sweep

- [ ] 3.1 Sweep `skills/forge/` (and `docs/`) for retired phrasing: no remaining
      "one question at a time" / "one question per message" instructions tied to
      brainstorm. Verify: `grep -rin "question at a time\|one question per message" skills/forge`
      returns nothing.
