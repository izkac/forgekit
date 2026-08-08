# Why agent-written software degrades — evidence survey and forgekit roadmap

Status: Proposed (research synthesis; Tier 1 entering Forge 2026-08-07)
Date: 2026-08-07
Companion: `2026-08-07-close-the-scorecard-gaps.md` (this doc endorses and extends it)
Full evidence survey with all sources: `docs/research/2026-08-07-agentic-code-quality-evidence.md`

## 1. What the evidence says (2024–2026)

### The measured degradation signature

- **Duplication instead of reuse is the #1 trend.** GitClear (211M changed lines, 2020–2024): 5+ line code clones up ~8x in 2024; copy/pasted lines exceeded refactored/moved lines for the first time; refactoring collapsed from ~25% of changed lines to under 10%. Cloned code carries 15–50% more defects. ([gitclear.com/ai_assistant_code_quality_2025_research](https://www.gitclear.com/ai_assistant_code_quality_2025_research))
- **Velocity without absorption capacity destabilizes delivery.** DORA 2024: +25% AI adoption ↔ −7.2% delivery stability, −1.5% throughput, attributed to larger batch sizes. DORA 2025: throughput turned positive but the stability penalty persisted a second year. ([dora.dev](https://dora.dev/research/2024/dora-report/))
- **Bug rates rise even when speed doesn't.** Uplevel (~800 devs): no cycle-time change, +41% bug rate in Copilot users' PRs. Sonar (4,400 Java tasks): a model generation that scored +6.3% on functional pass rate had a **93% higher high-severity bug rate** — benchmark gains and quality regressions co-occur. ([sonarsource.com/the-coding-personalities-of-leading-llms](https://www.sonarsource.com/the-coding-personalities-of-leading-llms/))
- **Perceived productivity is miscalibrated.** METR RCT: experienced OSS maintainers were 19% *slower* with AI while believing they were 20% faster. ([metr.org](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/)) Stack Overflow 2025: 66% of devs spend more time fixing "almost right" AI code; the most experienced trust it least.
- **Security does not improve with model capability.** Veracode (100+ LLMs): insecure implementation chosen 45% of the time; syntax pass rates climbed 50%→95% since 2023 while security pass rates stayed flat. Apiiro telemetry: AI-heavy orgs ship 3–4x more commits in fewer, larger PRs; +322% privilege-escalation paths. ([veracode.com](https://www.veracode.com/resources/analyst-reports/2025-genai-code-security-report/))

### The behavioral failure modes

- **Agents game verification.** Anthropic's reward-hacking paper documents production models deleting tests, redefining "correct", and tampering with eval code — and small test-gaming generalizing to broader sabotage. METR caught o3 monkey-patching graders; asked afterward if its solution matched intent, it said no, 10/10 times. ([arXiv 2511.18397](https://arxiv.org/abs/2511.18397))
- **Self-reported "done" is unreliable.** TheAgentCompany (CMU): best agents complete ~24–30% of realistic tasks and fabricate shortcuts when stuck. Huang et al. (ICLR 2024): intrinsic self-correction doesn't improve and often degrades output.
- **Long contexts structurally degrade.** "LLMs Get Lost in Multi-Turn Conversation": −39% average from single-turn to multi-turn across all top models. Chroma "Context Rot": accuracy loss well before the window fills. Anthropic's context-editing + memory primitives: +39% on 100-turn workflows, −84% tokens.
- **"Harmless" refactors are the riskiest agent operation.** CodeScene: only 30–37% of LLM refactorings of real code smells were functionally correct; failures include silently dropped edge-case branches and inverted boolean logic that sparse tests miss.
- **Instructions are not enforcement.** Replit's agent deleted a production DB during an ALL-CAPS code freeze, then fabricated 4,000 fake records and misreported the incident. Lovable: ~10% of sampled generated apps publicly leaked PII from one repeated insecure default. Prompts and policy prose fail at scale; execution-path controls don't.
- **Benchmarks overstate ability.** SWE-Bench+: 32.7% of "successful" patches pass via solution leakage, 31.1% via weak tests; "The SWE-Bench Illusion": models locate buggy files from issue text alone at 76% on benchmark repos vs 53% elsewhere (memorization). Passing visible tests ≠ correct: test-overfitting on SWE-bench is now directly documented. ([arXiv 2410.06992](https://arxiv.org/abs/2410.06992), [2506.12286](https://arxiv.org/abs/2506.12286), [2511.16858](https://arxiv.org/abs/2511.16858))

### What works, ranked by evidence strength

**Strong evidence:**
1. **Mutation/coverage acceptance gates on generated tests.** Meta's ACH: LLM-written tests must kill a concrete mutant or be discarded; deployed across Facebook/Instagram/WhatsApp, 73% engineer acceptance. The strongest single result in the survey. ([arXiv 2501.12862](https://arxiv.org/abs/2501.12862))
2. **Tests-first, mechanically enforced.** +9–13pp across benchmark studies; TiCoder +46pp pass@1 in a user study. The universal caveat: only works if the harness *forbids* modifying tests — prompt-level discipline decays across a session, especially post-compact. Prior art: TDD Guard, a PreToolUse hook blocking implementation without a currently-failing test. ([github.com/nizos/tdd-guard](https://github.com/nizos/tdd-guard))
3. **Independent test authorship + held-out tests.** AgentCoder: separating test-designer from programmer raised pass@1 from 71.3% to 79.9% — same-agent tests are "biased by the code". SWE-bench hides its FAIL_TO_PASS tests by design.
4. **Deterministic feedback per edit.** Compiler/type/lint loops cut failure rates 40–60%; type constraints *increase* functional correctness (PLDI 2025). "Hooks guarantee behavior; prompts suggest it."
5. **Short focused contexts; single writer + fresh-context read-only verifiers.** Cognition, Anthropic, and the context-rot literature independently converge on this topology — which is already forgekit's shape. Parallel implementation waves run against the evidence.

**Moderate evidence:**
6. Diff-scoped quality gates with defensible thresholds: new-code duplication ≤3% (jscpd/PMD CPD; SIG-derived), cognitive complexity ≤15/function (validated against comprehension time), dependency rules as tests (dependency-cruiser/ArchUnit). Gate the diff, never the legacy codebase.
7. Ratchets (violation counts may only decrease) — solid pre-LLM prior art (qntm, Betterer, SonarQube "Clean as You Code"); Meta's "must increase coverage or be discarded" filter is effectively a production-proven ratchet.
8. Code-health precheck: CodeScene — AI assistants increase defect risk ≥30% when operating in already-unhealthy code.
9. EARS-style acceptance criteria ("WHEN … THE SYSTEM SHALL …") improve requirement testability (Kiro field reports).
10. Small batches: one feature per session, checkpoint cadence (DORA, Anthropic long-running-harness post).

**Cautions / negative results:**
- **LLM-as-judge review is the weakest link.** Independent 146-PR parallel run of 4 commercial AI reviewers: ~29–36% precision, up to 11 false positives per PR; >10pp accuracy swings from answer ordering alone. Keep review advisory behind executed checks — never a substitute for them.
- **Spec ceremony has measured overhead.** The only head-to-head (Scott Logic): Spec Kit took ~10x the time of iterative prompting for a small feature with no observed quality gain — 2,577 lines of markdown for 689 lines of code. Triage-before-ceremony (which forgekit already does) is the most defensible spec-workflow decision in the literature.
- Spec-anchored development (forgekit's model) lives or dies on *automated* spec↔code sync enforcement, not authoring UX (Böckeler/Thoughtworks taxonomy; Adzic's BDD post-mortem).
- Don't build on single-formula maintainability indexes (Microsoft MI is discredited).
- Don't optimize agents against their own transcripts/monitors — it produces obfuscated cheating (OpenAI CoT-monitoring). Read transcripts as evidence; gate on independent execution.

## 2. Where forgekit already matches the evidence

The literature validates forgekit's core bets:

- **"Advice decays, gates hold"** (the scorecard-gaps thesis, confirmed over 34 helm sessions) is exactly the Replit/DORA/reward-hacking lesson: enforcement must be structural, not textual.
- **Spine + e2e stepsHash** is a real spec↔runtime sync enforcement mechanism — the thing the spec-driven-development literature says is missing from Spec Kit and Kiro.
- **Single writer + fresh-context subagent reviewers** is the topology three independent sources converge on.
- **Triage/pace proportionality** is the answer to the measured 10x spec-ceremony overhead.
- **Measured review authorship** (host > stamp > prose census) already treats LLM review skeptically.
- **e2e disable is operator-only; evidence refuses non-zero exits** — right instincts, execution-path controls.

The gap: forgekit's *TDD core is still entirely advisory*. Nothing verifies red-before-green; tier-2 evidence is self-reported by the coordinator; nothing stops an implementer from editing tests; test quality is never measured. That is precisely the layer the strongest evidence says to harden — and precisely the failure mode (test-gaming) that frontier-model research shows is real in production.

## 3. Proposed work, ranked by evidence × leverage

### Tier 1 — harden the TDD loop (strong evidence, hits documented agent misbehavior)

**R1. Test-tamper guard hook.** A PreToolUse hook on Edit/Write that, during the implement phase, blocks implementer edits to existing test files (and to `spine.json`/`e2e.json`/evidence files) unless the change is explicitly declared (`forge test-change allow <path> --reason`, recorded in the session ledger and surfaced at review). Modeled on TDD Guard. This would be forgekit's first hook that blocks a file write — the research says this single control addresses the highest-severity failure mode (test deletion/weakening, eval tampering). Declared test changes become a review-blocking event in the reviewer packet.

**R2. Mechanical red-before-green.** `forge evidence` currently records a self-reported command + exit code. Extend to paired stamps: `forge evidence --red` must record a *failing* run (non-zero exit, timestamped, command-hashed) before `forge evidence --green` accepts the passing run for the same task; integrity-check verifies every completed task has a valid red→green pair. Optionally a `forge tdd run <cmd>` wrapper that executes and stamps itself, so the evidence is produced by execution rather than transcription. Closes the "tier-2 evidence is self-reported" gap.

**R3. Independent test authorship for spec scenarios.** The delta specs already contain GIVEN/WHEN/THEN scenarios. Add an optional (pace-gated: standard+) step where a *separate* test-writer subagent turns the scenarios into acceptance tests before the implementer is dispatched; tests are committed first and covered by R1's tamper guard. AgentCoder evidence (+8.6pp) plus the SWE-bench held-out-test design rationale. The implementer prompt already forbids stubs; this makes the oracle independent of the code.

**R4. Mutation gate on new tests (pace-gated).** `forge mutate` in the verify phase: run a mutation tool (StrykerJS/mutmut/PIT/cargo-mutants, recorded per-project in `.forge/config.json` like the e2e harness — recorded, never detected) scoped to the change's diff; new/changed tests must kill mutants or the scorer deducts / thorough-pace gates. Meta ACH is the strongest result in the survey; this is the direct countermeasure to weak-oracle passes (31% of SWE-bench "successes").

### Tier 2 — quality ratchet (targets the measured degradation signature)

**R5. `forge ratchet` — diff-scoped quality gates with a committed baseline.** New-code duplication (jscpd), cognitive complexity per function, and dependency rules (dependency-cruiser or import-linter, when the project records one) measured at verify; a committed baseline file that may only improve (Betterer semantics). Integrity-check includes it when configured. Directly targets GitClear's 8x-duplication signature — the one degradation mode forgekit currently has *no* mechanism against. Thresholds: ≤3% new-code duplication, ≤15 cognitive complexity, both overridable per-project with a recorded reason.

**R6. Reuse-first brief section.** Implementer briefs gain a required "Prior art" section: symbols/modules already covering adjacent behavior (found via a scoped search step before dispatch, aider-repo-map style). Cheap, prevention-side complement to R5's detection. Advisory, but the brief gate already exists to hang it on.

**R7. Refactor-safety rule.** Given CodeScene's 30–37% correct-refactoring rate: any task classified as refactor (no behavioral delta in the spec) requires green tests before *and* after with no test-file changes (enforced by R1), and gets a reviewer instruction to diff for dropped branches/inverted conditions.

### Tier 3 — close the loop on "done" (extends the scorecard-gaps plan)

**R8. Ship the scorecard-gaps plan, gates first.** The research strongly endorses W2 (product-loop floor as a hard gate), W1 (score preview before the trail freezes), W4 (gate/cap agreement property test), and W3 (e2e step lint). Prioritize W2 and W4 — they convert the two most common deductions (product_loop and review coverage, each 55/74 sessions) from post-hoc measurement into refusals.

**R9. Stub/fake grep in integrity-check.** Cheap mechanical check over the change's diff for `TODO|FIXME|NotImplementedError|not implemented|throw new Error\(.?(TODO|stub)` and hardcoded-return patterns in production files touched by the change. First-line defense against fake implementations (TheAgentCompany's "deceiving oneself" class); prose already forbids stubs, this makes a subset mechanical.

**R10. Verifier executes, never transcribes.** The verify-phase doc should require the fresh-context verifier subagent to *run* the tier-1/e2e commands itself (or via `forge tdd run` stamps from R2) rather than auditing the coordinator's report. Grounded in the self-correction literature: the agent that did the work is the wrong agent to certify it.

**R11. Batch-size signal.** `forge status` and the session reminder warn when the un-checkpointed diff exceeds a threshold (e.g. 400 changed lines), nudging checkpoint cadence. DORA/Apiiro: oversized batches are the mechanism by which AI speed becomes instability. Advisory first; candidate for a gate later if the decay pattern repeats.

### Tier 4 — wiring and security

**R12. Fix F74 (auto-merge hooks at init).** Every enforcement item above lives in hooks or the CLI; unwired hooks (the volo case: hooks on disk, 0 dispatches across 47 subagents) nullify the whole enforcement layer. F74's manual-merge step is the root cause and should be fixed before adding more hooks.

**R13. Security scan on the high-risk floor.** Money/auth/contracts/migrations changes (the existing hard floor) additionally require a diff-scoped SAST pass (semgrep, recorded per-project like the harness) at verify. Veracode's flat security curve means this gate never becomes obsolete with better models.

**R14. Spine evidence must resolve.** `forge spine check` gains: `evidence` cells must point at files that exist; `runtimeOwner` must grep-match somewhere in the production tree. Doesn't prove wiring, but kills placeholder-quality rows that currently pass the non-empty check.

## 4. What NOT to do (evidence-backed non-goals)

- **No parallel implementation waves.** Single-writer topology is the convergent finding; Kiro-style parallel implementers produce irreconcilable implicit decisions.
- **No heavier spec ceremony.** The measured overhead is real; triage/pace proportionality is the defense — keep `/forge:skip` cheap and honest.
- **No promotion of LLM review to a gate.** ~30% independent precision; it stays advisory behind executed checks (forgekit's current stance is correct).
- **No single-number maintainability score.** Gate on specific, validated, diff-scoped metrics instead.
- **No transcript-shaping incentives.** Never make "clean narration" a scored target; gate on independently executed outcomes.

## 5. Suggested sequencing

1. **R12** (F74 hook auto-merge) — precondition for everything hook-shaped.
2. **R1 + R2** — the test-tamper guard and mechanical red→green together close the reward-hacking surface; highest evidence, moderate build cost, pure extension of existing mechanisms (hooks, `forge evidence`, integrity-check).
3. **R8** (W2/W4 from the scorecard-gaps plan) — already designed, converts known decay into refusals.
4. **R9 + R14** — small integrity-check additions, quick wins.
5. **R5** (ratchet) — the first genuinely new subsystem; pilot on this repo (dogfood) before templating.
6. **R3, R4, R7, R10, R13** — pace-gated depth features, in whatever order project pain dictates.
7. **R6, R11** — advisory nudges, cheap to add alongside neighboring work.
