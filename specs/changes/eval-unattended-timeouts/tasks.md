# Tasks

## 1. Unattended Forge-arm instruction
- [x] 1.1 RED: extend `evals/harbor/run.test.mjs` so a dry-run Forge
      `instruction.md` matches unattended / no human operator / never end a
      turn with a clarifying question, and baseline does not. Verify: that
      assertion fails on current `run.mjs`.
- [x] 1.2 GREEN: update the Forge treatment blurb in `evals/harbor/run.mjs`.
      Verify: `node --test evals/harbor/run.test.mjs` passes.
- [x] 1.3 Extend `evals/harbor/smoke.mjs`, `smoke-hard-v2.mjs`, and
      `smoke-campaign.mjs` so staged Forge instructions require the same
      unattended phrases. Verify: `npm run smoke:evals:campaign` (and the
      other smokes if run) pass.

## 2. Campaign timeout and version
- [x] 2.1 RED: tighten `evals/harbor/smoke-campaign.mjs` so every episode
      agent `timeout_sec` is 3600 and every episode version is `1.1.0`.
      Verify: smoke fails on current 1200 / 1.0.0 files.
- [x] 2.2 GREEN: set agent `timeout_sec = 3600.0` and `version = "1.1.0"` in
      all six `evals/harbor/tasks/forgekit-campaign-v1/episode-*/task.toml`
      files and matching versions in
      `evals/harbor/corpora/forgekit-campaign-v1.json`. Verify:
      `npm run smoke:evals:campaign` passes.
- [x] 2.3 `--no-tdd` Update the campaign episode version column in
      `evals/README.md` to `1.1.0` and note the 3600s agent cap.

## 3. Product loop
- [x] 3.1 Add `scripts/e2e/assert-unattended-forge-instruction.mjs`: read the
      `unattended-e2e` dry-run Forge `instruction.md` and require the
      unattended phrases. Verify: `forge e2e run` is green.
