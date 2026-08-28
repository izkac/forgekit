# Design — specs leftover sweep

## Context

OpenSpec leftover sweep (0.3.50) is two parts: a vendor skill that searches the
tree, and a Forge gate that demands `openspec-verify.md` / `Remaining: none`.
Specs-engine changes already have the same artifacts (`proposal.md`,
`design.md`, `tasks.md`, delta specs under `changes/<name>/specs/`). Forge
owns that engine, so the sweep can be bundled and always on. The gate must not
reuse `openspec-verify.md` — a specs session that somehow has an OpenSpec skill
on disk must not be asked for the wrong file.

`forge integrity-check` already covers spine, e2e, TDD stamps, and deferrals.
It does not grep leftover consumers. That stays out of integrity-check; the
sweep is a coordinator pass with a session report.

## Decisions

- **Decision: always on for `planType: specs`.**
  - Alternatives: detect a skill file (OpenSpec pattern — rejected; Forge ships
    the skill, so absence would be a packaging bug, not an optional profile);
    opt-in via `.forge/config.json` (rejected; leftover files are the failure
    mode this exists to stop).
  - OpenSpec stays optional: vendor `openspec-verify-change` is expanded-profile.

- **Decision: artifact name `spec-verify.md`.**
  - Alternatives: reuse `openspec-verify.md` (rejected — wrong engine, and the
    current skip-on-specs test would invert); generic `leftover-verify.md`
    (rejected — OpenSpec reports already live at `openspec-verify.md`).
  - Share the `Remaining: none` parser. Two check functions, one line grammar.

- **Decision: no `forge spec-verify` that greps the tree.**
  - The sweep is judgment (requirement mapping, leftover names, design
    adherence). The CLI only announces and gates the report, same as OpenSpec.
  - Alternatives: a CLI that runs ripgrep for tokens from the proposal
    (rejected as a false-confidence substitute for the coordinator pass).

- **Decision: leftover-name search is a first-class step, not a suggestion.**
  - OpenSpec's vendor skill is completeness / correctness / coherence. The
    files `tasks.md` forgot (stale package names, docs, Docker, CI) showed up
    as SUGGESTION leftovers. Forge already requires those to be fixed. The
    specs skill states that search explicitly: names the change is retiring
    (from proposal, design, and REMOVED requirements), grepped across the
    tree, excluding `changes/archive/` and historical changelog entries that
    do not instruct current behaviour.

- **Decision: coordinator runs it; final reviewer still must not grep.**
  - Same split as OpenSpec. Combined close: sweep, then closer on the post-fix
    diff.

- **Decision: `--allow-incomplete` waives the gate** the same way as other
  done-gate problems.

## Risks / Trade-offs

- Always-on adds a coordinator pass on every specs session, including small
  combined-ceremony changes. That is the point; combined close already runs
  the OpenSpec sweep when available.
- A noisy leftover grep (changelog, archive) must stay scoped or the sweep
  becomes busywork. The skill names the exclusions.
- Existing in-flight specs sessions that reach review after this ships will
  hit the new gate. `--allow-incomplete` is the escape for a session that
  cannot re-run verify.
