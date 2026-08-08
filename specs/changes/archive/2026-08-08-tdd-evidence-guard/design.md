# Design — tdd-evidence-guard

Brainstorm artefacts:
`.forge/sessions/20260807T180052Z-tdd-hardening-071439/brainstorm/{notes,decisions}.md`

## Context

Three mechanisms land together because they close one surface: the implement
loop's verification integrity. The guard makes existing tests unwritable by
default, `forge tdd run` makes red→green evidence a product of execution, and
the F74 fix makes the hook layer actually reach consuming projects.

## Decisions

### D1 — one classifier, two enforcement points (chosen over hook-only / backstop-only)

`guard.mjs` exports `classifyGuarded({ path, session, config, git })` used by
both the PreToolUse hook path (`forge guard check`) and
`runIntegrityChecks`. Hook-only would be Claude Code-only and inert when
unwired; backstop-only detects at `done` instead of preventing. Both share
one decision table so gate and hook can never disagree (the W4 lesson:
gate and cap must read the same state).

### D2 — baseline is `session.baseCommit`

Guarded test files are those **tracked at the session's base commit**
(`git ls-tree` membership), so tests written during the session stay free —
that is what makes hard-deny compatible with TDD. Renames count as
delete+add: the delete side is guarded. Integrity artifacts (`spine.json`,
`e2e.json`, `e2e-results.json`, `verify-evidence.md`, `test-evidence.md`,
`tdd-runs.jsonl`) are guarded regardless of age — they are evidence, and
direct agent edits to them are never legitimate. Note: `forge`-CLI writes to
these files (e.g. `forge e2e run` writing `e2e-results.json`) do not pass
through host tool calls, so the hook never sees them; the guard constrains
Edit/Write tool paths only.

### D3 — hook fail-open, backstop fail-closed

The hook allows on any internal error (missing git, unreadable session,
malformed input) with loud stderr — same policy as `enforce-model`: a broken
guard must never brick a session. The integrity backstop is the fail-closed
layer: it runs inside `forge phase done|finish` where refusing is safe.

### D4 — allowances are recorded escapes, not permissions

`forge test-allow <path> --reason "…"` appends
`{path, reason, at, phase}` to `guard-allowances.json` in the session dir.
The guard honors it (exact repo-relative path match); integrity honors it;
reviewer packets and `forge review-label final` context list open
allowances; the scorecard lists every allowance. The reason is mandatory and
non-empty. Gate-class session resolution applies (refuse on ambiguous
session), since an allowance weakens a gate.

### D5 — `forge tdd run` executes; contradiction is recorded, not hidden

`forge tdd run --task <nn-slug> --expect fail|pass [--] <cmd…>` spawns the
command (shell: false, args array; repo-root cwd; stdio inherited),
appends `{cmd, args, expect, exit, ok, startedAt, durationMs}` to
`tasks/<id>/tdd-runs.jsonl`, creating the task dir if needed. `ok` is true
iff the outcome matches `--expect` (`fail` → non-zero exit, `pass` → zero).
A contradicted expectation still appends its stamp (audit trail) and exits
non-zero. Timestamps come from the executing CLI, not the agent.

### D6 — stamp pairing enforced only for new sessions

`forge new` writes `features: { tddEvidence: true }` on the session.
`runIntegrityChecks` enforces "every completed task dir contains an ok
fail-stamp older than an ok pass-stamp **for the same command**" only when
the flag is present. Old sessions and mid-flight sessions never
retroactively fail. Tasks with no task dir are covered by the existing
scorer deduction, unchanged here.

"Completed" is read from the task directory's evidence files
(`test-evidence.md` or `tdd-runs.jsonl`), not from `tasks.md` checkboxes:
there is no stable id→directory mapping (this change's own `tasks.md` item
5.2 lives in `tasks/07-pairing-gate/`), and `plan-progress.mjs` uses
`tasks.md` only for aggregate counts.

**The pairing gate correlates by command (final review I2).** The qualifying
fail-stamp and pass-stamp must share `cmd` and `args`, not merely both exist
somewhere in the task dir: `forge tdd run --expect fail -- false` followed by
`forge tdd run --expect pass -- true` no longer satisfies the gate, even
though both stamps are genuine and CLI-authored — `false` and `true` are
unrelated commands, so no red→green cycle happened. A task may legitimately
carry several red→green pairs for different commands (one per file touched,
say); the gate asks whether *some* command has a qualifying fail-stamp
chronologically before a qualifying pass-stamp, not that every stamp in the
ledger agrees on one command.

**Acknowledged limit — the ledger is file-based, so it is forgeable.** A
hand-written `tdd-runs.jsonl` satisfies the gate. `tdd-runs.jsonl` is in the
guard's always-guarded artifact set, so an `Edit`/`Write`/`MultiEdit`/
`NotebookEdit` on it is denied; but the hook does not see Bash redirection,
and session-dir files are gitignored and therefore invisible to the
diff-based backstop (see the SCOPE NOTE in `integrity.mjs`). This gate raises
the cost of fabricating red→green evidence from "type a command and an exit
code into a report" to "deliberately forge a timestamped ledger, with a
consistent command name, that a real red→green cycle would have produced";
it does not make it impossible. That is the intended bar — the same one D3
draws between incidental and deliberate.

### D7 — settings merge is structural, not textual

`mergeHooksIntoSettings({ settings, snippet })` deep-merges hook entries:
for each event key in the snippet, append matcher-groups whose `command`s are
not already present (basename match, consistent with `checkHookWiring`);
never reorder or remove user entries; create `.claude/settings.json` when
missing. Pure function, unit-tested over real-world shapes (empty file, user
hooks present, repeated runs → no duplicates). `forge init` and
`forge doctor --install` both call it; the snippet file is still written.

### D8 — guard window is implement→finish

Fast-allow when session phase is triage/brainstorm/plan or done/skipped.
Deny window covers implement, verify, review, finish — the entire span where
gamed tests pay off.

## Risks

- **Over-broad globs** deny legitimate edits (e.g. `test-utils.mjs` under a
  `test/` dir). Mitigation: `.forge/config.json → guard.testGlobs` overrides
  defaults; the deny message names the glob that matched and the allowance
  command.
- **Merge corrupting user settings.** Mitigation: pure-function merge with
  idempotency tests; JSON parse failure → refuse to write and print the
  manual instruction (never write a best-guess file).
- **Windows**: spawn without shell, path normalization in the classifier
  (posix-style repo-relative paths); CI matrix already runs windows.
