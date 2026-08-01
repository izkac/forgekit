# Tasks

## 1. Structural rejection markers (F59)

- [x] 1.1 RED: review-census test — file with "REJECT if any of" + APPROVED
      has rejections 0; file with `## Round 1 — REJECTED` still counts 1.
      Verify RED.
- [x] 1.2 GREEN: tighten REJECTION_RE. Existing rejection tests green.
      Resolve F59.

## 2. Product-loop e2e

- [x] 2.1 E2e: plant approve-with-reject-instructions vs real round rejection;
      forge score / census notes must not count the former. Status line.
      `forge e2e run` green.
