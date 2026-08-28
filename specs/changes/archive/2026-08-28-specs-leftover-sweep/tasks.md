# Tasks

## 1. CLI gate

- [x] 1.1 Add `SPEC_VERIFY_BASENAME` (`spec-verify.md`), `sessionNeedsSpecVerify` (true only for `planType: specs`), and `checkSpecVerifyArtifact` in `packages/cli/src/openspec-verify.mjs` (or a sibling module that both engines import). Specs: always required, no skill-file probe. Missing file or missing `Remaining: none` is not ok. OpenSpec sessions must not require `spec-verify.md`. Reuse `remainingFindingsCleared`. Tests in `packages/cli/src/openspec-verify.test.mjs` (or the sibling's test file) — verify: specs session without the file → `required: true, ok: false`; with `Remaining: none` → ok; OpenSpec session → specs check not required; specs session still skips `openspec-verify.md` even if the vendor skill is on disk.
- [x] 1.2 `packages/cli/src/set-phase.mjs`: `forge phase review` / `done` / `finish` refuse without a passing spec leftover check; `forge phase verify` announces the sweep on stderr for specs sessions (mirror `announceOpenSpecVerify`). `--allow-incomplete` waives. Combined close still tells the coordinator to sweep first. Tests in `packages/cli/src/set-phase.test.mjs` — verify: specs session, no `spec-verify.md`, `forge phase review` exits non-zero and names `spec-verify.md`; `Remaining: none` plus other gates waived via `--allow-incomplete` where needed lets review through; OpenSpec leftover tests stay green.

## 2. Guard freeze

- [x] 2.1 Treat `spec-verify.md` as an integrity artifact with the same freeze window as `openspec-verify.md` (editable through verify, frozen from review). Files: `packages/cli/src/guard.mjs`, `packages/cli/src/guard-cli.mjs` (`RULE_GUARD_FROM_PHASE`). Tests in `packages/cli/src/guard.test.mjs` and `packages/cli/src/guard-cli.test.mjs` — verify: basename is guarded; Write during verify is allowed; Write during review is denied with `integrity-artifact:spec-verify.md`.

## 3. Coordinator skill and phase copy

- [x] 3.1 Add `skills/forge/skills/specs-verify-change/SKILL.md`: select the change under `<plan.dir>/changes/<name>/`; completeness (tasks + delta requirements); correctness (requirement and scenario mapping); coherence (design.md); leftover-name search (retired names from proposal/design/REMOVED, tree search, skip `changes/archive/` and historical changelog that does not instruct current behaviour); fix CRITICAL/WARNING/SUGGESTION; skip only explicit no-action or recorded design decision; save `spec-verify.md` with Forge disposition and `Remaining: none`. Coordinator runs this, not the final reviewer. Pin: skill exists and names `Remaining: none` plus leftover-name search.
- [x] 3.2 Point verify/close/apply at the skill. `skills/forge/phases/verify.md` §7 grows a specs branch (always on; do not invent a parallel sweep when `planType` is openspec). `skills/forge/phases/close.md` step 2. `skills/forge/skills/verification-before-completion/SKILL.md`, `skills/forge/skills/subagent-driven-development/SKILL.md`, `skills/forge/subagents/final-reviewer-prompt.md`, `skills/forge/docs/forge.md`, `skills/forge/references/forge-layout.md`. `/forge:apply` in `.cursor/commands`, `.claude/commands`, and `templates/project/{cursor,claude}/commands`. Verify: those files name `spec-verify.md` for specs and still name `openspec-verify.md` only for OpenSpec.

## 4. Product loop and operator docs

- [x] 4.1 Product loop: `scripts/e2e/spec-leftover-gate.mjs` drives the shipped `forge` binary against a throwaway specs-engine project — session `planType: specs` at verify, `forge phase review` refuses without `spec-verify.md`, then a report with `Remaining: none` lets review through (other done-gates waived as the existing OpenSpec leftover tests do). Wire `e2e.json`. Verify: `node scripts/e2e/spec-leftover-gate.mjs` prints a green token the e2e step expects.
- [x] 4.2 Operator docs: `docs/usage.md` done-gate example, `docs/day-to-day.md` leftover-sweep paragraph, `CHANGELOG.md`. Verify by reading: specs sessions are told about `spec-verify.md`; OpenSpec copy is unchanged.
