# Tasks

Test-first. Every guard here has already been written once and **four of them
were unpinned when first written** — the mutant survived. Prove each one kills a
test before moving on.

`starting-point.patch` holds the previous implementation. Read it, but re-derive
the decisions: it was written against reproductions from one call site, and its
whole defect class was landing fixes where the reproduction was rather than
where the decision lives.

## 1. One resolver

- [ ] 1.1 `forge phase` resolves through `resolveSessionId()`. Tests: two
      unfinished sessions → refuses, names both as `--session <id>`, and changes
      **nothing** (no phase write, no scorecard, no ledger line); `--session`
      proceeds; an unreadable sessions directory refuses; ENOENT does not.
      **The money/auth case is the one that matters** — assert it against
      `forge phase done` specifically, not only against a cheaper phase.
- [ ] 1.2 `forge status` and the SessionStart reminder resolve the same way, so
      they cannot tell the operator one thing while the gate does another.
      Tests: with an ambiguous project, `status` reports the ambiguity rather
      than picking.

## 2. The pointer tracks the work

- [ ] 2.1 `forge phase` marks the session it transitioned as active — **below
      every gate** (a refused transition must not move it) and **never on
      `done`/`skipped`** (finished work must not capture the pointer, the resume
      hook, or the label). Tests: refused transition leaves it untouched;
      terminal phases leave it untouched; an ordinary transition moves it.
- [ ] 2.2 A failed pointer write warns and names the remedy instead of being
      swallowed. Test: `.forge` read-only → exit 0, transition completes,
      warning on stderr.

## 3. Atomic writes

- [ ] 3.1 `writeJson` writes to a temp file and renames. Measured why: two
      concurrent writer processes produce **62 torn reads in 79** on a plain
      write and 0 over a rename, and a torn `active.json` costs `forge cleanup`
      its live-session guard and makes the SessionStart hook emit nothing.
      Test by inode replacement, not by racing a writer — a timing test that
      passes on a fast machine teaches nothing.

## 4. Close the back door

- [ ] 4.1 Migrate the remaining `readActive()` callers (`defer`, `findings-cli`,
      `brief-cli`, `integrity-check`, `score-cli`, `cleanup-sessions`, `e2e`,
      `checkpoint`, `metrics-cli`) or make `readActive` private to `lib.mjs`.
      **Decide first whether any of them is a gate rather than a convenience** —
      `forge phase done` was assumed to be a convenience for eight review rounds.
- [ ] 4.2 One paragraph in `docs/usage.md` and `skills/forge/docs/forge.md`:
      which session a bare command acts on, and that it refuses when ambiguous.

## 5. Product loop

- [ ] 5.1 An e2e step: two sessions open, bare `forge phase done`, assert it
      refuses and that neither session was scored or written to the ledger. This
      is the regression that must never come back — it was live in 0.3.29 and
      cost the money/auth gate entirely.
