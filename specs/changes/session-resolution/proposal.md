# Commands disagree about which session they are acting on

## Why

`.forge/active.json` is written by **`forge new` alone**, so "the active session"
means *most recently created* — not the one being worked on. Every command that
resolves a session without being told which reads that pointer, and there are
twelve of them.

Measured, through the real CLI, with two sessions open and the pointer naming the
wrong one:

- **`forge phase done` — the money/auth gate — gates the neighbour.** It scores
  it, writes its scorecard and its `sessions.jsonl` line. The high-risk change it
  was supposed to judge ends at `implement` with no verdict, no scorecard and no
  durable record that it was ever gated. The final-review floor never runs.
- **`forge phase verify` reopens a finished neighbour** (`done → verify`),
  because a bare phase command follows the same pointer.
- **`forge status` and the SessionStart hook agree with each other and with the
  pointer**, so nothing on screen contradicts the wrong answer.

This was found while shipping `review-authorship-evidence`, which needed to know
which session a reviewer was dispatched for. That change fixed it *for its own
command* — `forge review-label` refuses rather than guessing. The rest of Forge
was left on the old behaviour, and the gate is the worst of them.

**Split out deliberately.** It is a different bug from the one that surfaced it,
it is larger, and bundling it took an unrelated change from two files to thirty.

## What changes

- `resolveSessionId()` in `lib.mjs` becomes the one place this is decided, and
  `forge phase` uses it: explicit `--session` wins; an unreadable sessions
  directory refuses; more than one unfinished session refuses and names each
  candidate as the flag that selects it; the pointer wins only when it names
  unfinished work. `unfinishedSessions()` and `resolveSessionId()` already exist
  and are already used by `forge review-label`.
- **`forge phase` marks the session it transitioned as active** — below every
  gate, so a refused transition does not move the pointer, and never on
  `done`/`skipped`, so finished work cannot capture `forge status`, the resume
  hook, or the label.
- A failed pointer write **warns**; it is currently swallowed, and its comment
  calls the pointer "a convenience", which stops being true the moment the gate
  reads it.
- **`writeJson` becomes atomic** (temp + rename). Measured with two concurrent
  writer processes: **62 torn reads in 79** on a plain write, 0 over a rename. It
  only matters once `active.json` is written on every transition, which is why it
  belongs here rather than with the change that found it.
- The remaining ten `readActive()` callers migrate, or `readActive` becomes
  private to `lib.mjs` so the next one cannot get it wrong.

## Impact

- `packages/cli/src/lib.mjs`, `set-phase.mjs`, `session-status.mjs`, and the ten
  commands listed in the finding
- **Behaviour change worth naming:** `forge phase` will refuse in a project with
  two sessions open unless `--session` is given. That is heavier than today and
  needs its own review — it can block `implement` and `verify`, not only `done`.
- `starting-point.patch` in this directory holds the implementation as it stood
  when it was split out, with tests. It is a starting point, not a plan.
