# Design — escape tracking

## D1. Commit range at done

`session.commitRange = { base: session.baseCommit, head: <git rev-parse HEAD> }`, set in
`set-phase.mjs` only on `done`, after every gate has passed and before the scorecard writes the
digest. `appendSessionDigest` copies it as `commitRange`; `registerSession` copies it into the fleet
entry. No `baseCommit` or no git → `commitRange` stays absent (never a fake range).

## D2. Which sessions `forge escapes` scans

- `.forge/sessions.jsonl` rows with `phase: done` in this project.
- Fleet registry entries with `phase: done` whose project root is this root or whose
  `projectName` equals this repo's (linked worktrees of this repo — volo's parallel sessions).
- Deduped by `sessionId`; the digest row wins (it has `endedAt`), registry `updatedAt` otherwise.
- No `commitRange` → infer from `git log <ref> --fixed-strings --grep "forge(<slug>):"`:
  base = oldest's parent, head = newest; `inferred: true`. Nothing found → reported as skipped.
- `head` not an ancestor of `<ref>` (unmerged branch, squash merge) → skipped with that reason.

Alternative rejected: scanning `--all`. Unmerged experiment branches would surface as candidates.

## D3. Escape candidates

For a session with range `base..head` and done time `T`:

1. `changeCommits = rev-list base..head`.
2. `files = git diff --name-only base head`, minus `<plan.dir>/` and `.forge/` (not code).
3. `later = git log --no-merges --since=T --until=T+14d <ref> ^head -- files`, minus same-session
   commits: in `changeCommits`, or subject starting `forge(<slug>)`.
4. For each later commit `C`: parse `git diff -U0 -M C^ C -- files` hunks; for each hunk with old
   lines, `git blame --porcelain -L a,+n C^ -- <old path>`; any line blamed to a `changeCommits`
   SHA → candidate. Record overlapped line count and files.

This is literally "modifies or deletes lines the change added": the blame of the parent at exactly
the lines `C` removes or rewrites.

## D4. Decisions ledger

`.forge/escapes.jsonl`, one line per `(sessionId, commit)`:
`{ sessionId, slug, commit, subject, decision: confirmed|dismissed, replayTest, reason, decidedAt }`.
Written with `withLedgerLock` + `readLedger` + `writeLedger` (replace on same key). Decided pairs are
not listed again by `forge escapes`.

Confirm: replay test = `--test <path>`, else the fix commit's touched test files
(`*.test.*`, `*.spec.*`, `*_test.*`, `test_*.py`, `/test/`, `/tests/`, `__tests__/`), first one.
None → refuse with "pass --test <path>". A supplied path must exist in `C`'s tree or on disk.

Interactive (stdin and stdout are TTYs, no subcommand): per candidate print a summary and read one
key — `c` confirm, `d` dismiss, `s` skip, `q` quit. `c` with no test in the commit prompts for a path
(line input).

## D5. Escape rate report

Projects = this root + every fleet registry project root still on disk (deduped). Done sessions =
union of their `sessions.jsonl` done rows and registry done entries (by `sessionId`). Escapes =
union of their `escapes.jsonl` confirmed lines. Bucket by month (`YYYY-MM`) of done:
`done`, `escaped` (≥1 confirmed), `rate`, `open` (14-day window not yet closed). `--json` for machines.

## D6. Gate fires

`gate-fires.mjs` exports `GATE_IDS` (the known gates), `firesLogPath()` =
`path.join(path.dirname(fleetDir()), 'gate-fires.jsonl')`, `recordGateFire(gate, { sessionId,
cwd, detail })` and `readGateFires()`. Append-only under `withLedgerLock`; never throws; skips
projects under `os.tmpdir()` unless `FORGEKIT_FLEET_DIR` is set (same rule as the registry).
Machine-level, not per project: volo worktrees are deleted after merge and their `.forge/` with them.

Fire sites (one line per refusal; the done gate logs one line per failing sub-check):

| gate id | where |
| --- | --- |
| `integrity-seal` | set-phase seal mismatch |
| `brief` | set-phase implement brief gate |
| `brainstorm-notes` | set-phase plan notes gate |
| `leftover-sweep` | set-phase review/done verify artefact |
| `done:verify-evidence`, `done:tasks`, `done:combined-review`, `done:archive`, `done:integrity` | done gate sub-checks |
| `final-review-floor` | set-phase |
| `reopen-floor` | set-phase |
| `integrity-check` | `forge integrity-check` exit 1 |
| `test-guard` | `forge guard check` deny |
| `model-policy` | enforce-model deny |
| `evidence` | `forge evidence` refusal |
| `exec-gate` | `forge tdd run` exec refusal |
| `tdd-expectation` | `forge tdd run` red/green mismatch |
| `review-label` | review-label refusals |
| `task-gate` | `forge gate check` failure |
| `checkpoint` | `forge checkpoint` refusal |

`forge fires [--json] [--since <iso>]` prints count, sessions and last fire per gate, every `GATE_IDS`
entry included (zeros are the point), plus unknown ids seen in the log.

## Risks

- Inferred ranges for old rows depend on checkpoint commit subjects; sessions that never
  checkpointed are skipped, not guessed.
- Blame cost is one call per hunk; acceptable at forgekit/volo history sizes.
