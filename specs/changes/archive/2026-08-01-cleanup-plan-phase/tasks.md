# Tasks

## 1. Protect plan-phase sessions with a live change dir (F48)

- [x] 1.1 RED: in `packages/cli/src/lib.test.mjs` (cleanup cases), an aged
      unfinished session with only scaffold files in the session dir but
      `openspecChange` pointing at an existing `specs/changes/<name>/`
      must NOT be removed by bare `forge cleanup` / cleanup-sessions.
      Explicit `--include-unfinished --session <id>` still removes it.
      Verify RED.

- [x] 1.2 GREEN: implement the change-dir check in
      `packages/cli/src/cleanup-sessions.mjs` (plan.dir aware). Same tests
      green. Resolve F48.

## 2. Product-loop e2e

- [x] 2.1 `scripts/e2e/cleanup-plan-phase.mjs` + `e2e.json`: aged plan
      session + live change dir survives cleanup; named
      `--include-unfinished --session` deletes it.
      Expect a single status line. `forge e2e run` green for this change
      when this session owns it.
