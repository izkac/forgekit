# 0001. Harness prerequisites are recorded, not detected

- **Status:** Accepted
- **Date:** 2026-07-26
- **Area:** e2e harness / runtime integrity
- **Related:** [specs/changes/archive/2026-07-26-harness-setup-probe](../../specs/changes/archive/2026-07-26-harness-setup-probe/), [specs/specs/e2e-harness/spec.md](../../specs/specs/e2e-harness/spec.md)

## Context

A recorded harness held `description` / `start` / `dir` — how to boot the app
under test, and nothing about the rig that exercises it.

The failure this surfaced, reported from the field: an agent recorded a
Playwright harness, `/forge:harness` proved it green in the agent's environment,
and the operator's fresh checkout failed on the first `npm run test:e2e` with
"browser executable doesn't exist". The agent's sandbox already had the
browsers. The harness was proven exactly where nobody needed it proven.

The obvious fix is for forge to check: look for `@playwright/test` in
`package.json`, run `playwright --version`, verify the browser path, and fail
the prove step with the install command before the probe runs. That was the
shape of the original proposal.

## Decision

Forge records machine-local prerequisites as an opaque string (`setup`) and the
command that proves the harness (`probe`). When a loop goes red and a `setup` is
recorded, `forge e2e run` names it as the first thing to suspect.

**Forge never detects tools, never checks whether a prerequisite is satisfied,
and never installs anything.** The probe's own failure is the check; forge's
contribution is attribution.

The accompanying rule, carried in the skill reference and both `/forge:harness`
command templates: *a harness proven only in the agent's environment is not
proven.* Anything the agent installed to make the probe pass belongs in `setup`.

## Alternatives considered

**Per-tool detection with a pre-prove environment check.** Rejected. It requires
a bespoke recipe per tool — Playwright, Cypress binaries, chromedriver, Docker
images, a Go toolchain — each with a different "is it installed" question, a
different version-skew rule, and its own way of going stale when the tool
changes its CLI. Forge would carry an ecosystem matrix it cannot keep current,
to produce an error message the tool already produces correctly. The generic
check already exists: run the probe.

**Auto-install via `--install-setup`.** Rejected. Setup commands are
multi-hundred-megabyte downloads by nature. Printing a command the operator
copy-pastes costs one line; owning an installer means owning its failure modes
in CI, in sandboxes, and behind proxies.

**A third `setupHint` field for prose.** Rejected. It is a comment on `setup`,
and the harness already has a free-text `description`. Every additional flag is
another thing an agent gets wrong at record time.

## Consequences

### Positive

- Tool-agnostic by construction. A harness using something nobody has heard of
  is supported on day one, with no forge change.
- No surprise downloads in CI or agent sandboxes.
- Nothing to keep current as tools change their CLIs.
- `probe` closes a separate gap: `/forge:harness` step 1 already told agents to
  re-run "one real probe" against an existing harness, with nowhere to record
  which one.

### Negative

- **The hint can misattribute.** A step failing for an ordinary code reason
  still prints the setup line whenever a setup is recorded. Mitigated by wording
  it as a suspicion tied to this checkout, printing it once after the step list,
  and never letting it change the exit code. If it becomes noise, the answer is
  to soften the wording — not to start guessing which failures are
  environmental, which is this decision reversed.
- **Recording is voluntary.** Nothing forces `--setup`; the skill text carries
  the obligation, as it already does for `--start`.
- Forge cannot verify a recorded setup was ever applied.

### Neutral

- Both fields are optional; harnesses recorded before this print unchanged.
- Reversing this decision means adding a detection layer *above* the recorded
  string, not changing the data model — the fields stay useful either way.

## References

- Capability spec: [specs/specs/e2e-harness/spec.md](../../specs/specs/e2e-harness/spec.md)
- Rationale in full: [design.md](../../specs/changes/archive/2026-07-26-harness-setup-probe/design.md)
- Rule as shipped to agents: `skills/forge/references/runtime-integrity.md`
  ("A harness proven only in your environment is not proven")
