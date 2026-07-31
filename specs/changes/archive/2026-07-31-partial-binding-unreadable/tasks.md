# Tasks

## 1. Absent and unreadable stop being the same answer

- [x] 1.1 **Failing test first, F27's own case.** In
      `packages/cli/src/metrics/review-evidence.test.mjs`: a session bound to two
      host sessions, the second's `projects/<project>/<host-id>/` directory
      `chmod 000`, the prescribed final-review dispatch planted in the second.
      Assert `available: false`. Assert the fixture is real with
      `assert.throws(() => fs.statSync(sidecarPath), /EACCES/)` and restore the
      mode in a `finally`, per the convention at `review-evidence.test.mjs:725`.
      This test MUST fail on today's code with `available: true` — record that
      observed failure, not an assumed one.

- [x] 1.2 **Shape only, no behavior change, tree green at the end.**
      `packages/cli/src/metrics/host.mjs` — `findTranscripts` returns
      `{ found, unreadable }`. `found`'s elements keep the exact shape
      `{ sessionId, transcript, sidecarDir }`; `unreadable` carries
      `{ sessionId, path, reason }` and is **empty in every case** at this task,
      because no error is classified yet. Update both call sites by one
      destructure: `review-evidence.mjs:517`, `collect.mjs:258`. Move the five
      `deepEqual`s in `host.test.mjs` to the new shape. Update the JSDoc, whose
      current text ("Ids with no transcript are omitted rather than reported") is
      now half the story.
      Verify: `node --test packages/cli/src/metrics/` green, 1.1 still failing
      for its original reason — `available: true`, not a crash.

- [x] 1.3 **The sidecar split — this is the task that turns 1.1 green.**
      `packages/cli/src/metrics/host.mjs`: sidecar stat `ENOENT` →
      `sidecarDir: null` as today; any other error, **or `isDirectory()` false**
      → the entry still lands in `found` and the id also lands in `unreadable`.
      `packages/cli/src/metrics/review-evidence.mjs`: return `unavailable(...)`
      naming ids and paths when `unreadable` is non-empty, checked **before** the
      `sidecarDirs.length === 0` guard. Replace the `KNOWN HOLE` block at line
      527 with a note recording what the `ENOENT` split bought and what it
      deliberately left — the pruned-transcript residual, and that F12's
      dispatch-time stamp is its fix.
      Add to `host.test.mjs`: a `subagents` path planted as a regular file →
      `unreadable`.
      Verify: 1.1 green; `node --test packages/cli/src/metrics/` green.

- [x] 1.4 **The transcript split.** `packages/cli/src/metrics/host.mjs`:
      `ENOENT` → keep searching the remaining project directories. Any other
      error → remembered per id, promoted to `unreadable` only if the id is found
      in **no** project at all. Tests in `host.test.mjs`, the three scenarios in
      the `review-evidence` delta's second requirement:
      found-in-B-after-EACCES-in-A (clean, `unreadable` empty),
      found-nowhere-with-A-unsearchable (unreadable, not absent), and
      absent-everywhere-all-readable (omitted, and **not** unreadable).
      Verify: `node --test packages/cli/src/metrics/host.test.mjs`.

- [x] 1.5 **The gate, end to end at unit level.** A test proving the partial
      binding no longer reaches `review-census.mjs`'s `bucket === undefined` →
      `self` branch: given evidence from a half-read binding, the census verdict
      is the prose reading on `inferred` grade, not `self` on `host`. Place it
      where the census is already exercised (`review-census.test.mjs`, or
      `set-phase.test.mjs` if the gate transition is the clearer surface).
      Verify: the new test fails when `review-evidence.mjs`'s unreadable guard is
      commented out — check that, do not assume it.

- [x] 1.6 Confirm the existing `readdirSync` case at
      `review-evidence.test.mjs:710` still passes unchanged — it covers a
      different failure and must not be absorbed by the new guard. No edit
      expected; if one is needed, that is a signal the guard is too wide.

## 2. A partial harvest says so

- [x] 2.1 **Failing test first.** `packages/cli/src/metrics/collect.test.mjs` —
      two bound host sessions, the second unreadable. Assert the document is not
      `degraded`, that its totals match the readable session alone, and that it
      names the unread id. Must fail today (no such field).

- [x] 2.2 `packages/cli/src/metrics/collect.mjs` — destructure `found` at line
      258; keep the existing `bound.length === 0` degrade for the genuinely
      empty case. Record unreadable ids on the returned document. Verify: 2.1
      green, and the all-readable case's totals byte-identical to before.

## 3. Product-loop acceptance

- [x] 3.1 `scripts/e2e/harness-portability.mjs` — add step
      `review-evidence-partial-binding`, declared in `e2e.json`. The fixture
      inverts the gate rather than confirming it: a session bound to two host
      sessions, the second's directory `chmod 000`, the reviewer dispatched in
      the second, and a review file whose **prose reads independent** (a
      genuinely dispatched reviewer wrote it).

      Today that combination gives `evidence=host, final=self` and `forge phase
      done` **refuses correct work** at the money/auth gate. After the fix the
      evidence is unavailable, prose decides, and the gate **accepts**. Assert
      the accept and `evidence=inferred`, and emit
      `PARTIAL binding=half-read gate=accepted evidence=inferred`.

      Follow `review-evidence-decides` (line 647): run the refusal as a control
      **first**, so a fixture whose prose would not read as independent cannot
      make this pass for free. Restore the directory mode in a `finally` — a
      `chmod 000` left behind breaks every later step. Register the step name in
      the usage string at line 1146.

      Verify: `node scripts/e2e/harness-portability.mjs review-evidence-partial-binding`
      exits 0, and fails on `git stash` of the source change.

## 4. Whole-workspace verification

- [x] 4.1 `npm test` at the workspace root, green. Then `npm run lint`.

- [x] 4.2 `forge e2e run`, green, with the boot step.

- [x] 4.3 Re-read the two delta specs against the shipped code and confirm each
      scenario has a test that would fail if its behavior were reverted —
      including the pruned-transcript scenario, which asserts the limit this
      change keeps rather than a behavior it adds.

- [x] 4.4 **Prose that outlived its defect.** Added after task 1.3's review found
      it; it is not in the original Impact list, and nothing else in the plan
      would have caught it.

      `packages/cli/src/set-phase.mjs` carries two comments asserting F27 is
      unfixed — near line 369, "a session bound to two whose second sidecar
      directory is unreadable still answers confidently from the first (F27,
      owned by `host.mjs`)", and near line 551, "`reviewEvidence` can answer
      confidently from a partially readable binding". The first is now flatly
      untrue. Rewrite both to say what is now true **and** what remains true:
      the pruned-transcript residual still answers from the surviving half.
      Do not simply delete them — a reader at the gate needs the limit stated.

      Two cosmetic fixes in `packages/cli/src/metrics/host.mjs` while there,
      both in strings an operator reads at a refused gate:
      the `EACCES` reason renders as `EACCES: EACCES: permission denied…`
      because Node's `err.message` already leads with the code; and the
      not-a-directory reason embeds the full path, which
      `review-evidence.mjs`'s guard already prints alongside it.
      Also wrap the two lines that exceed the file's 100-column norm.

      **One more, added by task 1.4's review and not cosmetic:** since 1.4 the
      `unreadable` list carries transcript-level entries as well as sidecar ones,
      but `review-evidence.mjs` still destructures it as `unreadableSidecars` and
      prints `sidecar directory could not be read — … (<path>)`. A transcript
      entry therefore renders as a sidecar directory naming a `.jsonl` file —
      a false sentence in front of a human at a refused gate. Rename the local
      and rewrite the message so it fits both kinds. Behavior does not change:
      the guard already refuses on any non-empty `unreadable`, which is correct.

      Verify: `node --test "packages/cli/src/metrics/*.test.mjs"` and
      `node --test packages/cli/src/set-phase.test.mjs` green; `npm run lint`
      clean.

- [x] 4.5 **Two spec scenarios with no test at all.** Added by task 4.3's audit,
      which proved both by mutation rather than by reading.

      **(a) "A transcript that was pruned, not blocked" is unpinned.** Inserting
      `if (bound.length < sessionIds.length) return unavailable(…)` into
      `reviewEvidence` — the exact over-cautious drift this design rejected —
      leaves the **entire 751-test suite green**. The behaviour is correct; a
      probe against shipped code with two bound ids, the older absent and the
      newer carrying a prescribed `final` dispatch, returns `available: true`
      with `units.final.dispatched === 1`. Nothing holds it there.

      This is the residual the whole change deliberately declined to fix, and an
      unpinned limit is how a later change quietly "fixes" it and makes every
      resumed session unavailable the day its older transcript ages out.

      Add to `review-evidence.test.mjs`, mirroring the fixture at the F27 test
      but with **no chmod at all**: host session A with a prescribed
      `forge-review final <id>` dispatch, bound as `[ABSENT_ID, A]` where
      `ABSENT_ID` has no `.jsonl` anywhere. Assert `available === true` **and**
      `units.final.dispatched === 1`. Comment that this pins a deliberate limit
      in the *permissive* direction so a future reader does not "fix" it.
      Add the companion at `review-census.test.mjs` asserting the verdict is
      `independent` on `host` — that is the assertion that fails loudly the day
      the gate starts refusing resumed sessions.

      **(b) "the reason names the host session id and the path" is unpinned.**
      Replacing the whole detail string with a literal leaves everything green.
      Extend the F27 test with `assert.match(result.reason, …)` for the second
      host id and for `subagents`. The reason string is the only diagnostic an
      operator gets when the gate stands aside.

      **(c) Weak, worth closing while there:** the "exists and is not a
      directory" arm is pinned only at `findTranscripts` level
      (`host.test.mjs`). No test runs `reviewEvidence` over a `subagents` path
      that is a regular file, though the scenario says "WHEN the census runs".

      Each new test must be shown to redden against the mutation named above it.

      Verify: `node --test "packages/cli/src/metrics/*.test.mjs"`,
      `node --test packages/cli/src/review-census.test.mjs`, `npm run lint`.
