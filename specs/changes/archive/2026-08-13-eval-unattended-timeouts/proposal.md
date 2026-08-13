# Eval Unattended Timeouts

## Why

The first `forgekit-campaign-v1` live cohort scored Forge worse on functional
(6/12 vs 8/12) because three Forge trials never finished the requested work:
one stopped to ask a human who does not exist in Harbor, and two hit the
20-minute agent timeout while still in verify or plan. Repetition 001 was a
tie. The comparison was not of finished coding work.

## What Changes

- The Forge-arm instruction injected by the Harbor runner tells the agent the
  trial is unattended: no operator, never end a turn with a question, pick a
  default and continue. Baseline instruction stays as it is.
- Campaign episode agent timeout becomes 3600 seconds on both arms. Episode
  versions become 1.1.0 in lockstep with the manifest.
- Smoke and runner tests lock the new instruction phrases and the 3600-second
  campaign floor. README episode versions follow.

## Capabilities

- `benchmark-harness`: unattended Forge-arm instruction
- `evaluation-corpus`: campaign timeout and episode version 1.1.0

## Impact

`evals/harbor/run.mjs` staging, campaign `task.toml` files, the campaign
manifest, smoke/runner tests, and evals README. A later live campaign run is a
new 1.1.0 cohort; do not pool it with the 1.0.0 run. hard-v2 timeouts stay
1200 seconds. The Forge skill is not edited.
