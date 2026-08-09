# Tasks

## 1. Live progress
- [x] 1.1 Add RED→GREEN runner tests for validated progress intervals, stderr lifecycle/heartbeats, stdout JSON integrity, and sanitized messages; implement in `evals/harbor/run.mjs`.

## 2. Portable, private telemetry
- [x] 2.1 Add RED→GREEN coverage proving Forge summaries and normalized results contain a trial-output-relative `artifactLocator` and no checkout/run-root path; remove `artifactPath`.
- [x] 2.2 Add RED→GREEN adversarial coverage that keeps paths and downstream content out of public failure diagnostics while retaining private local logs.
- [x] 2.3 Add RED→GREEN adversarial coverage that whitelists provider identity/version provenance without serializing injected fields.

## 3. Closeout
- [x] 3.1 Update evaluation docs, run eval/workspace/lint/smoke/E2E verification, obtain independent approval, and archive the change.
