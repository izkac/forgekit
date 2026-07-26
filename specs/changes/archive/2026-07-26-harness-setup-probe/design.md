# Design

## Context

The originating report proposed four changes: new `setup`/`probe`/`setupHint`
config fields, a prove-step environment check that detects `@playwright/test` in
`package.json` and runs `playwright --version` before declaring the harness
proven, richer harness output, and skill text about verifying browser binaries.
The operator reviewed the alternatives in-session and chose the leaner shape.
This file records why the middle two were narrowed.

## Decisions

- **Decision: record `setup` and `probe`; do not add `setupHint`.**
  - Alternatives considered: the reported three-field shape
    (`probe` / `setup` / `setupHint`), where `setupHint` carries prose like
    "Playwright browsers (one-time / after @playwright/test upgrade)".
  - Rationale: `setupHint` is a comment on `setup`, and the harness already has
    a free-text `description` field that the `--set` flag fills. Every extra
    flag is another thing an agent gets wrong at record time, and this one holds
    nothing the description cannot. Two new flags, not three.

- **Decision: no per-tool detection; attribute failures instead of predicting
  them.**
  - Alternatives considered: detect `@playwright/test` in `package.json` during
    the prove step, run a cheap check (`npx playwright --version`, browser path
    existence, `playwright install --dry-run`), and fail the prove step with the
    exact install command before the probe runs.
  - Rationale: forge is tool-agnostic and would need a check recipe per tool —
    Playwright, then Cypress binaries, chromedriver, Docker images, a Go
    toolchain, each with a different "is it installed" question and a different
    version-skew rule. The generic check for "is the setup satisfied" already
    exists: it is the probe, which fails with the tool's own diagnostic. What
    forge can add without knowing any tool is *attribution* — when a step fails
    and a `setup` is recorded, name it as the first suspicion. This covers every
    ecosystem at once and cannot go stale as tools change their CLIs.

- **Decision: hang the hint off `forge e2e run`, not only the prove step.**
  - Alternatives considered: surfacing the setup command only in
    `/forge:harness`, where the reported failure occurred.
  - Rationale: the prove step is a skill instruction and runs when someone
    deliberately visits the harness. `forge e2e run` is where a fresh clone
    actually hits the missing runtime — mid-session, at the integrity gate, with
    a step failure that reads as a code regression. That is where the hint pays.

- **Decision: never auto-run `setup`.**
  - Alternatives considered: an `--install-setup` flag on the prove step.
  - Rationale: `setup` commands are multi-hundred-megabyte downloads by nature.
    Forge printing a command the operator copy-pastes costs one line; forge
    owning an installer means owning its failure modes in CI and sandboxes. The
    recorded string is already the whole value.

## Risks / Trade-offs

- **The hint can misattribute.** A step that fails for an ordinary code reason
  will still print the setup line whenever a `setup` is recorded. Mitigation:
  word it as a suspicion tied to *this checkout* ("if you have not run it here"),
  print it once after the step list rather than per-step, and never let it change
  the exit code — the failing step remains the headline.
- **Fields are only as good as what gets recorded.** Nothing forces an agent to
  pass `--setup`, so the skill text carries the obligation. Accepted: this
  mirrors how `--start` and `--dir` already work.
- **No migration.** Harnesses recorded before this change simply lack the keys;
  `harnessLines()` already prints fields conditionally.
