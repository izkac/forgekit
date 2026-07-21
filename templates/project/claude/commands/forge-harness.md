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

- **Harness shown** → verify it still works: run its start command, then one real probe against it. Working → report to the user and stop. Broken → continue to step 2, treating the existing harness as the starting point (fix, don't rebuild).
- **"No harness recorded"** → step 2.

## 2. Design it with the operator

Explore the project first: how the app starts, what backing services it needs, and what a real user-visible probe looks like (HTTP endpoint, CLI invocation, UI route). Then propose to the user:

- what the harness starts (app + backing services, isolated ports/data so it can't touch dev state)
- how a test asserts *through the product* (the probe `forge e2e` steps will use — not internal function calls)
- where it lives (e.g. `scripts/e2e/`, a compose file, a test config)

**Get explicit approval before building.** A harness is committed project infrastructure, not session scratch.

## 3. Build and prove

Build the approved harness. Prove it end-to-end: start it, run one real probe, show the user the output. A harness that has never gone green is not done.

## 4. Record it

```bash
forge e2e harness --set "<what/where>" --start "<command>" [--dir <path>]
```

Then commit `.forge/config.json`. Every future session sees the harness on `forge e2e init` and reuses it instead of rebuilding or asking again.

Reference: `~/.claude/skills/forge/docs/forge.md`
