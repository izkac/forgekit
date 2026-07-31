# Tasks

## 1. Atomic writeStamp (F62)

- [x] 1.1 RED: in `packages/cli/src/review-stamp.test.mjs`, add a test that
      after a successful `writeStamp` the live `reviews/dispatches.json` is
      valid JSON with the new stamp, and that a pre-planted
      `dispatches.json.tmp` with garbage does not prevent the next write or
      poison `readStamps` / `readExistingForWrite`. Verify:
      `node --test packages/cli/src/review-stamp.test.mjs` (new cases fail).
- [x] 1.2 GREEN: change `writeStamp` in `packages/cli/src/review-stamp.mjs` to
      write `${file}.tmp` then `fs.renameSync` onto `file`. Keep
      refuse-on-malformed and never-throw. Same test file goes green.

## 2. Dedupe sessionIds (F61)

- [ ] 2.1 RED: tighten
      `packages/cli/src/metrics/review-evidence.test.mjs` ("a bound host id
      repeated…") so `units.final.dispatched === 1` (and seen/prescribed do not
      double). Add a `host.test.mjs` case that `findTranscripts([id, id], …)`
      returns one `found` entry. Verify the new assertions fail on current code.
- [ ] 2.2 GREEN: order-preserving dedupe of non-empty string ids at the start
      of `findTranscripts` in `packages/cli/src/metrics/host.mjs`. Both new
      assertions green; existing host / review-evidence suites stay green.

## 3. Named readdir-blocked reason (F60)

- [ ] 3.1 RED: tighten
      `packages/cli/src/metrics/review-evidence.test.mjs` ("sidecar directory
      exists but cannot be read") to assert the reason includes the host
      session id and the sidecar directory path. Verify it fails today.
- [ ] 3.2 GREEN: include the directory path in `scanSidecar`'s readdir-blocked
      reason in `packages/cli/src/metrics/review-evidence.mjs`; when
      `reviewEvidence` surfaces that unavailable answer, include the owning
      host session id (same naming shape as other blocked-sidecar reasons).
      Tightened test green.

## 4. Product loop + findings

- [ ] 4.1 Author `scripts/e2e/stamp-follow-ups.mjs` (and `e2e.json` steps):
      write two stamps via `writeStamp` and assert a valid live file with no
      required leftover `.tmp`; plant a duplicate `sessionIds` binding and
      assert `reviewEvidence` reports `dispatched === 1` for the final unit;
      plant a chmod'd sidecar and assert the unavailable reason names id and
      path. Wire `forge e2e init` / steps so `forge e2e run` is green.
- [ ] 4.2 Resolve findings F60, F61, F62 with short notes pointing at this
      change.
