# Combined close (small changes: verify + review in one pass)

Applies when the session's `resolvedCeremony` is **`combined`** (`forge status`).
The resolver grants it only to small, single-capability, low-risk changes with no
wired spine rows; everything else follows [verify.md](./verify.md) then
[review.md](./review.md) as before. If `resolvedCeremony` is missing or `full`,
this file does not apply — do not choose it yourself.

**Why this exists:** measured on the sonnet-hard-v2 cohort, the tail (verify +
review + done) cost 2–4M input tokens per trial against 0.4–0.9M for implement.
Three phases each re-established context to check work that one diff-read
covers. On a small change, one closer subagent does the same checking at a
fraction of the cost — and the integrity gates at `forge phase done` are
unchanged, so nothing rides on trust.

**Request budget:** the whole close — audit, one closer dispatch, one fix round,
finish — should land around 10–15 requests. If you find yourself far above that,
you are re-running the full tail under another name; stop and check why.

## Steps

1. **Mechanical audit (coordinator, no dispatch).** Confirm every task is
   ticked in `tasks.md` (or session progress), each behavior-change task has its
   red→green stamps (or `--no-tdd` declaration), and `spine.json` carries its
   `notApplicable` reason. This is reading artifacts, not re-running commands.

   ```bash
   forge phase verify
   ```

2. **One closer dispatch.** Take the label first — the closer **is** the
   session's final reviewer:

   ```bash
   forge review-label final --tier standard   # small change: standard, not capable
   ```

   Dispatch [../subagents/closer-prompt.md](../subagents/closer-prompt.md) with
   the Task description exactly what the command printed. Fill every
   placeholder: `{DIFF_RANGE}` from `forge checkpoint --range` (whole session;
   plus untracked files by name), `{TASK_EVIDENCE_TARGETS}` one entry per task,
   `{AFFECTED_TEST_COMMAND}` the narrowest command covering the touched
   workspace(s), `{GUARD_ALLOWANCES}` pasted or "none". **Model:** resolve via
   `forge resolve-model --tier standard` and honor `omitModel`/`model` literally.

3. **Record.** Save the closer's report verbatim to
   `.forge/sessions/<id>/reviews/final-review.md`. Write
   `.forge/sessions/<id>/verify-evidence.md` naming the closer's tier-3 command,
   exit code, and summary (that run *is* the session's tier 3 — do not re-run
   it), or `BLOCKED: <reason>` if it could not run.

   ```bash
   forge phase review
   ```

4. **Fix round (at most one).** `NOT READY` → fix the named findings (dispatch a
   fix subagent for anything non-trivial), have the **same closer** re-check the
   changed files only, and update both records. Still `NOT READY` → escalate to
   the human with the findings; do not loop.

5. **Finish as normal** — [finish.md](./finish.md): archive, `forge phase done`
   (runs `forge integrity-check`), cleanup. Every gate that guards the full tail
   guards this one.

## Hard floor (unchanged)

Money / auth / contracts / migrations / secrets never resolve to `combined` —
the resolver enforces it, and if you can see high-risk work that slipped through
(a mid-session scope change, say), treat the session as `full` and say so. Wired
spine rows always take the full tail: an executed product loop cannot be
replaced by a diff-read.
