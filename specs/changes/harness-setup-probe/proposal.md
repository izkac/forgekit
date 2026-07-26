# Harness setup + probe: make a recorded harness portable off the agent's machine

## Why

`forge e2e harness` records `description` / `start` / `dir`. Two things it does
not record cost real time:

**The probe is nowhere.** `/forge:harness` step 1 tells the agent to verify an
existing harness by running "its start command, then one real probe" — but the
probe was never recorded, so every session re-derives it from the project. The
skill asks for something the data model cannot hold.

**Machine-local prerequisites are nowhere.** A field report: an operator
recorded a Playwright harness with `--start "npm run build && npm run preview"`.
`/forge:harness` proved it green in the agent environment and reported the
harness done. On the operator's own checkout, `npm run test:e2e` failed with
Playwright's "browser executable doesn't exist — run `npx playwright install`".
The harness recorded *how to boot the product* but not *how to make the probe
runtime exist on this machine*, and the agent's sandbox already had the
browsers. A harness proven only where the agent stands is not proven.

These are the same omission at two layers: the recorded harness describes the
app under test and says nothing about the rig that exercises it.

## What Changes

- `forge e2e harness --set` accepts `--probe <cmd>` (the command that proves the
  harness) and `--setup <cmd>` (machine-local prerequisites: browsers, drivers,
  images, toolchains).
- `forge e2e harness`, `forge e2e init`, and `forge e2e status` print/serialize
  both fields alongside `Start:` and `Location:`.
- When `forge e2e run` has a failing step and the project records
  `e2e.harness.setup`, the run output names that setup command as the first
  thing to suspect. No tool detection, no auto-install — forge attributes, the
  operator decides.
- Skill + docs state the portability rule: anything the agent installed to make
  the probe pass is not in the repo and not on the operator's machine, and must
  be recorded as `setup`.

## Capabilities

- `e2e-harness`: what the recorded project harness holds, how it is surfaced,
  and how a failing loop points at missing machine prerequisites.

## Impact

- `packages/cli/src/e2e.mjs` — flag parsing, `harnessLines()`, run-failure hint.
- `packages/cli/src/e2e-cli.test.mjs` — coverage for both new fields and the hint.
- `templates/project/{claude,cursor}/commands/forge-harness.md` — record + prove
  steps teach the new flags and the portability rule.
- `skills/forge/references/runtime-integrity.md` — harness recording block.
- `docs/usage.md`, `CHANGELOG.md`.

Backward compatible: both fields are optional, harnesses without them print
exactly as they do today, and `forge e2e status` already serializes the whole
harness object so consumers see the new keys without a schema change.

Not in scope (considered and rejected — see design.md): per-tool detection of
Playwright/Cypress in `package.json`, a pre-prove environment check, and an
`--install-setup` auto-runner.
