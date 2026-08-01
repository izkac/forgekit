# Tasks

## 1. Pass evidence on live census (F63)

- [x] 1.1 RED: score/ledger test — stamped final with host evidence of a
      measured stop must not grade finalReviewEvidence `recorded` on the live
      path (no frozen verdict). Verify RED.
- [x] 1.2 GREEN: wire reviewEvidence into score.mjs + ledger.mjs live calls.
      Resolve F63.

## 2. Product-loop e2e

- [x] 2.1 E2e asserting live score with stamp+stop evidence does not claim
      recorded independence wrongly. Status line. forge e2e run green.
