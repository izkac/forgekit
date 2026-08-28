---
name: /forge:harness
description: Forge — ensure the project has a working, recorded e2e harness
category: Workflow
tags: [workflow, forge, e2e]
---

**Forge-owned command.** Ensure this project has a working, recorded e2e harness — the environment `forge e2e run` steps execute against, and the base for the project's own end-to-end testing. Building it proactively here means later sessions never stall at the integrity gate waiting for one.

## 1. Check what's recorded

```bash
forge e2e harness
```

- **Harness shown** → verify it still works. Run its `Setup:` command first if one is recorded and you have not already run it in this environment, then `Start:`, then the recorded `Probe:`. No probe recorded → derive one, and record it in step 4 so the next session doesn't repeat the work. Working → report to the user and stop. Broken → continue to step 2, treating the existing harness as the starting point (fix, don't rebuild).
- **"No harness recorded"** → step 2.

## 2. Design it with the operator

Explore the project first: how the app starts, what backing services it needs, and what a real user-visible probe looks like (HTTP endpoint, CLI invocation, UI route). Then propose to the user:

- what the harness starts (app + backing services, isolated ports/data so it can't touch dev state)
- how a test asserts *through the product* (the probe `forge e2e` steps will use — not internal function calls)
- what a fresh checkout needs installed before that probe can run at all (browsers, drivers, container images, toolchains)
- where it lives (e.g. `scripts/e2e/`, a compose file, a test config)

**Get explicit approval before building.** A harness is committed project infrastructure, not session scratch.

## 3. Build and prove

Build the approved harness. Prove it end-to-end: start it, run one real probe, show the user the output. A harness that has never gone green is not done.

- **Proven here is not proven there.** Your environment is not the operator's. Anything you installed to make the probe pass is in neither the repository nor their checkout — a probe runtime you had all along is the failure they hit on first run. Track what you installed and record it as `--setup` in step 4. Caches in an agent sandbox do not count as the operator having the tool.
- **Never install on their behalf.** These are large downloads and the operator's call. Forge records the command and prints it; it does not run it.

## 4. Record it

```bash
forge e2e harness --set "<what/where>" \
  --start "<command that boots the app under test>" \
  --setup "<machine-local prerequisites, if any>" \
  --probe "<command that proves the harness>" \
  [--dir <path>]
```

`--setup` and `--probe` are optional but nearly always worth it: `setup` is what a fresh checkout must install before the probe can run, and `probe` is what the next session re-runs at step 1. When a loop later goes red, `forge e2e run` names the recorded `setup` as the first thing to suspect — a missing browser stops reading as a code regression.

Then commit `.forge/config.json`. Every future session sees the harness on `forge e2e init` and reuses it instead of rebuilding or asking again.

Reference: `~/.agents/skills/forge/docs/forge.md`
