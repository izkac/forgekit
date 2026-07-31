# Tasks

## 1. readJsonl says what happened (F56)

- [x] 1.1 **Failing tests first, both layers.**
      (a) `packages/cli/src/metrics/transcript.test.mjs`: `readJsonl` on a
      content-blocked file (`chmod 000` on the **file**, directory readable,
      guarded by `assert.throws(() => fs.readFileSync(...), /EACCES/)` and
      restored in a `finally`) reports `error.code` `EACCES` and no lines; on a
      missing file reports `error.code` `ENOENT`; on an empty file reports
      `error === null`. Must fail today — the shape does not exist.
      (b) `packages/cli/src/metrics/collect.test.mjs`: an **unflagged** id —
      both sessions located cleanly, second's transcript file content-blocked —
      yields totals from the first alone, `source.unread` equal to
      `[{ sessionId, counted: false }]`, and `available: true`. Must fail today:
      the silent undercount with zero trace that F56 names.
      Record both observed failures, not assumed ones.

- [x] 1.2 **Shape change, callers opt in or out, no behavior change beyond the
      new field.** `packages/cli/src/metrics/transcript.mjs`: `readJsonl`
      returns `{ lines, error }` per the delta spec — `error` null on success
      including empty, `{ code, message }` otherwise, `ENOENT` **included**
      (the JSDoc must state the deliberate divergence from `host.mjs` and why:
      searching vs reading). Malformed lines stay skipped. Translate the eight
      bare-array tests; the missing-file case now asserts `error.code`.
      Update all five call sites: `transcript.mjs` host-version,
      `review-evidence.mjs:313` sidecar counts, `collect.mjs:183` version sniff
      → `.lines` (advisory, visibly discarding); `collect.mjs` parent and
      sidecar totals loops → destructure and thread `error` to where 1.3 will
      use it, unused for now.
      Verify: 1.1(a) green; 1.1(b) still red **for its original reason** —
      missing `unread` entry, not a crash; `node --test
      "packages/cli/src/metrics/*.test.mjs"` otherwise green.

- [x] 1.3 **Delete the probe; derive `counted` from the read that feeds the
      totals.** `packages/cli/src/metrics/collect.mjs`: remove `readSucceeded`
      and its second `readFileSync` entirely; `counted` and membership in
      `source.unread` now come from the totals read's own `error`, for every
      bound id, flagged or not. The prior change's two pinned tests —
      sidecar-blocked `counted: true` path and genuinely-empty `counted: true`
      — must stay green **unedited**; if either needs an edit, stop and report.
      Verify: 1.1(b) green; full metrics suite green. Then prove it: restore a
      `boundIds`-style derivation (counted from `found` membership) and confirm
      1.1(b) reddens; delete the `unread` spread and confirm all
      unread-dependent tests redden.

## 2. Unreadable is diagnosed before absent (F57)

- [x] 2.1 **Failing tests first.**
      (a) `packages/cli/src/metrics/review-evidence.test.mjs`: a session bound
      to one host session whose transcript cannot be examined (project
      directory `chmod 000`, id lands in `unreadable`, never `found`) →
      `available: false` with a reason naming the id and path, **not**
      matching `/pruned or written elsewhere/`. Must fail today on the reason.
      (b) `packages/cli/src/metrics/collect.test.mjs`: same fixture → degraded,
      reason naming the blocked id, not the pruned message.
      (c) `collect.test.mjs`: reading-layer variant — one bound id, found
      cleanly, content-blocked → degraded, reason naming the read failure
      rather than only "held no readable lines". Must fail today.

- [x] 2.2 `packages/cli/src/metrics/review-evidence.mjs`: move the `unreadable`
      guard ahead of `bound.length === 0`. The existing unreadable message is
      already worded for both entry kinds (prior change, task 4.4) — no text
      change expected; if one proves necessary, say why. **High-risk (gate
      evidence path): immediate per-task review regardless of pace.**
      Verify: 2.1(a) green; the F27 test, the pruned-limit test and the census
      join test all green untouched.

- [x] 2.3 `packages/cli/src/metrics/collect.mjs`: same reorder; the degraded
      reason names the blocked ids. The reading-layer all-blocked degrade
      (currently "held no readable lines") names the read failures when errors
      exist — an empty-but-readable binding keeps the current wording. No
      `unread` on degraded documents, per the delta spec.
      Verify: 2.1(b) and (c) green; full metrics suite green.

## 3. Verification

- [x] 3.1 `npm test` at the workspace root, green; `npm run lint` clean.

- [x] 3.2 `forge e2e run` green — regression through the shipped binary: the
      gate still accepts the half-read binding (`review-evidence-partial-binding`
      unchanged from the prior change; this change alters diagnosis, never the
      decision).

- [x] 3.3 **Spec-to-test mutation audit**, as in the prior change: every
      scenario in both deltas must have a test that reddens when its behavior
      is broken. Named mutations to include: revert `readJsonl` to the bare
      array; treat empty content as a failed read; re-derive `counted` from
      `found` membership; restore the guard order in each consumer. Report a
      per-scenario table with observed reds.

      **Added by group 1's review:** the double-membership case — an id both
      sidecar-flagged AND content-read-failed — is handled correctly by the code
      (the reviewer constructed it: one `unread` entry, `counted: false`) but no
      test pins it. Add that test as part of this audit, and prove it reddens
      against a mutation that emits two entries or `counted: true`.
