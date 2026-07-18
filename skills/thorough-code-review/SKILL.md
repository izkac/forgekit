---
name: thorough-code-review
description: >-
  Performs two-phase code review with adversarial false-positive verification across
  security, correctness, smells, architecture, performance, tests, contracts, errors,
  and maintainability. Grounds findings in a signals pre-flight, balances precision with
  a recall/coverage pass, and risk-weights skeptic verification. JSON is the source of
  truth; the Markdown is generated from it. Writes reports to .reviews/. Supports lens
  narrowing, dedupe pre-flight, fix re-verification, and CI export. Use when the user
  asks for code review, thorough review, security review, PR review, /review, or
  --verify-fixes / re-verify findings.
disable-model-invocation: true
---

# Thorough Code Review

Two-phase review: **scout** discovers tentative issues; **skeptic** subagents attempt to disprove each claim. Skeptic dispatch is severity-routed and budgeted — it is **not** one subagent per finding. Only verified findings appear in the main report.

Three properties keep it honest:

- **Grounded** — a signals pre-flight runs real tools (typecheck, lint, tests) so findings start from fact, not guesswork.
- **Complete** — a recall/coverage pass balances the skeptic's precision by checking what the scout *missed*.
- **Risk-weighted** — the dangerous quadrant (a high-severity finding one skeptic wants to dismiss) gets a second, independent skeptic before it vanishes.

## When to use

- Pre-merge or pre-hand-off review
- Security or correctness audit of a diff, path, or service
- Re-verification after fixes (`--verify-fixes`)
- CI validation via `review export`

**Not** a replacement for Forge `requesting-code-review` — invoke this skill explicitly.

## Scope resolution

**If the user did not specify a target, ask** which scope applies:

| Option | How to read |
| ------ | ----------- |
| Uncommitted | `git diff` + untracked in scope |
| Branch vs main | `git diff main...HEAD` (or repo default branch) |
| Paths / services | User-provided paths |
| Commit range | `git diff BASE..HEAD` |
| Single file | Deep read of one file |

## Lens narrowing

Default: **all lenses**. User may narrow with flags or phrases:

| Flag | Lens |
| ---- | ---- |
| `--security` | AuthZ, injection, secrets, crypto |
| `--correctness` | Logic, races, edge cases, idempotency |
| `--smells` | Duplication, complexity, dead code |
| `--architecture` | Boundaries, coupling, layering |
| `--performance` | N+1, hot paths, allocations |
| `--tests` | Coverage, mock-heavy tests |
| `--contracts` | OpenAPI drift, breaking changes |
| `--errors` | Silent failures, propagation |
| `--maintainability` | Readability, file size |

Read only matching sections from [reference/lenses.md](reference/lenses.md).

## Workflow overview

```
Scaffold report   → review new <slug> --type <t>
Resolve scope + lenses
  → Prior-report carry-forward (inherit verdicts for unchanged code)
  → Signals pre-flight (run grounding tools; seed grounded findings)
  → [if smells] Dedupe pre-flight (read-only)
  → Phase 1: Scout      (partition + parallel scouts when scope is large)
  → De-duplicate tentative findings
  → Phase 1.5: Coverage pass  (recall — what did the scout miss? orchestrator-inline)
  → Phase 2: Skeptic    (severity-routed + budgeted: dedicated for critical; batched for
                         important/minor; inline verdicts for cheap cases; second skeptic
                         for the dangerous quadrant)
  → Phase 3: Synthesis  (edit JSON → review:render → review:export)
```

### Scaffold first

Generate the report skeleton up front so the timestamp, review id, scope slug, and git SHAs are captured deterministically (never hand-author these):

```bash
review new mercury-vat --type branch
review new persona-profile --type paths --paths services/persona --lenses security,correctness
```

This writes `.reviews/<id>-review.json` with empty findings. You fill findings into the JSON as you work, then render and export.

### Prior-report carry-forward

Don't re-litigate verdicts the last review already earned. Before scouting:

1. Find the most recent `.reviews/*-review.json` whose scope overlaps this one (same service/paths). None → skip this step.
2. Run the script — it copies each verdicted finding whose file is unchanged since the parent's recorded SHA into the new report (verdict preserved, reason cites the parent + SHA), skips the rest with reasons, and refuses to write an invalid report:

   ```bash
   review carryforward --parent <prior-review-id> --file .reviews/<new-id>-review.json
   # add --dry-run to preview
   ```

3. List carried-forward false positives in the scout packet as "known false positives — do not re-raise". Findings whose file changed are fair game — the scout re-examines them fresh.

### Signals pre-flight

Ground the scout in real tool output before reading code by hand. Run [reference/signals-preflight.md](reference/signals-preflight.md):

1. `review signals --type branch` (or `--paths a,b`) prints the typecheck/lint/test commands for exactly the workspaces in scope.
2. Run them; convert genuine failures into **grounded** tentative findings (`confidence: high`).
3. Record what ran in the JSON `signals` object.

Grounded findings below `important` **skip Phase 2** — a compiler or test failure is already tool-proven; the orchestrator just checks it isn't intentional WIP (recent commit message, TODO, user context) and records the verdict directly. Grounded findings at `critical`/`important` still get a skeptic.

The dedupe pre-flight (below) is the smells-lens special case of this pattern.

#### Dedupe pre-flight (smells lens only)

When `smells` is active (including "all"):

1. Read the project `dedupe` skill.
2. Run a **read-only** duplicate scan on the review scope only.
3. Emit `dup-###` tentative findings; merge into Phase 1 list.
4. Include `dedupe_preflight` in JSON and Appendix B in the rendered markdown.
5. **Do not edit code** during review.

### Phase 1 — Scout

Follow [reference/phase1-scout.md](reference/phase1-scout.md).

**Scale by partitioning.** A single scout reading every file degrades on large scopes. When the scope exceeds ~10 files or ~800 changed lines, split it into reviewable units (by module, or by lens) and run **parallel scout subagents** — capped at **4 scouts**; for bigger scopes make the units larger rather than the scout count higher. Each scout writes its tentative findings to `.reviews/<id>-tentative/<scout-name>.json` (`{ "findings": [...] }` in the scout format); then merge + dedupe + renumber deterministically:

```bash
review merge --dir .reviews/<id>-tentative
```

Small scopes stay a single pass (no tentative dir needed).

Output tentative findings with: `id`, `lens`, `location`, `claim`, `evidence`, `tentative_severity`, `confidence`. Calibrate severity using [reference/severity-rubric.md](reference/severity-rubric.md).

### Phase 1.5 — Coverage pass (recall)

The skeptic optimizes precision; nothing else guards against silent misses. After scout, run the coverage critic in [reference/phase1c-coverage.md](reference/phase1c-coverage.md). The orchestrator does this pass **inline** (no subagent) — it already holds the scope and the merged finding list; dispatch a single coverage subagent only when the scope was partitioned across scouts and the file list is too large to re-check in context:

- Which in-scope files received **zero** findings — actually clean, or skipped?
- Which active lens produced **zero** findings — real, or not exercised?
- Emit any follow-up tentative findings (they go through Phase 2 like the rest).
- Record the ledger in the JSON `coverage` object (`files_reviewed`, `files_skipped`, `lenses_without_findings` with a reason each).

### Phase 2 — Skeptic

Dispatch skeptic subagents (Task tool) with **no chat history**, filling [reference/phase2-skeptic.md](reference/phase2-skeptic.md) placeholders. Mode `initial` for full reviews.

**Cheap verdicts first — a subagent is the last resort, not the default.** Before dispatching anything, drain the no-dispatch paths:

1. **Carry-forward** — verdict inherited from a prior report (see above).
2. **Grounded skip** — tool-proven findings below `important` skip Phase 2 entirely (see signals pre-flight).
3. **Inline verdict** — `minor` findings with `confidence: high` whose scout packet (`context` + `related`) already contains everything needed: the orchestrator runs the disproof checklist itself, records the verdict with evidence, and counts it under `stats.inline_verdicts`. No subagent. If the checklist turns up anything non-local (unclear callers, possible mitigation elsewhere), promote it to a batched dispatch instead.

Route the remainder by severity:

- **`critical`** — one **dedicated** skeptic per finding.
- **`important`** — batch findings **sharing a file** (or tight module) into one skeptic dispatch, cap ~4 per batch; an important finding alone in its file gets a dedicated dispatch.
- **`minor`** — batch by file, cap ~6 per batch.
- Every batched skeptic reads the file once and returns an **independent verdict block per finding** — never let one verdict color another.

**Dispatch budget.** Default cap: **~12 skeptic dispatches** per review (dedicated + batched + second opinions combined); the user can raise it (`--budget N`) or lift it ("no budget"). When the tentative list would exceed the budget:

1. Sort by severity, then by scout confidence (low confidence first — those need verification most).
2. Batch more aggressively (merge adjacent-file batches into module batches) before dropping anything.
3. Move remaining `minor` findings to inline verdicts.
4. Never leave a finding unverdicted, and never silently drop one — if the budget genuinely cannot cover a finding, report it with verdict `needs_decision` and a reason noting it was not adversarially verified.

Dangerous-quadrant second opinions count against the budget and are capped at **3 per review**, highest severity first.

**Hard rules:**

- Steelman the claim first.
- Every verdict needs `verdict_reason` with evidence.
- `false_positive` findings go to the report appendix, not the main body.

**Risk-weighted dispatch.** Spend the adversarial budget where a wrong call is most costly. A finding is in the **dangerous quadrant** when:

- it is `critical`/`important` and a single skeptic returns `false_positive` (risk: dismissing a real bug), or
- `phase1_confidence: high` but the skeptic returns `false_positive` (scout/skeptic disagreement), or
- `phase1_confidence: low` and `severity: critical` (high-stakes, low-certainty).

For these, dispatch a **second independent skeptic** (no history, no knowledge of the first verdict). Record it in the finding's `second_opinion` object. If the two disagree, keep the higher-severity outcome or route to `needs_decision` — never silently drop it.

### Phase 3 — Synthesis

**JSON is the single source of truth. The Markdown is generated from it — never hand-author the `.md`.**

1. Fill findings, `summary` (with `headline` and `top_actions`), `coverage`, `signals`, and `stats` (dispatch counters: `scouts`, `skeptics_dedicated`, `skeptics_batched`, `inline_verdicts`, `grounded_skips`, `carried_forward`, `second_opinions`) into the scaffolded `.reviews/<id>-review.json`.
2. Generate the paired markdown: `review render --file .reviews/<id>-review.json`.
3. Validate + summarize: `review export` (add `--fail-on critical|important` for a CI gate).

The summary verdict counts must reconcile with the findings — `review:export` rejects a report whose summary disagrees with its own body, so let render/export own the counts.

## Fix verification (`--verify-fixes`)

When the user fixed issues or asks to re-verify:

1. Scaffold a reverify report: `review new <slug> --kind reverify --parent <review_id>`.
2. Load prior report JSON (user path, or latest `*-review.json` in `.reviews/`).
3. Filter findings where prior `verdict` was `confirmed` or `downgraded`.
4. Phase 2 only: skeptics with `MODE=reverify` in [reference/phase2-skeptic.md](reference/phase2-skeptic.md) — same severity routing, batching, budget, and model tiers as initial mode.
5. Verdicts: `resolved` | `still_open` | `partially_fixed` | `regressed`.
6. Also scout the **fix diff itself** for regressions a per-finding recheck would miss, then `review:render` + `review:export`.

`new-review --kind reverify` sets `kind: reverify` and `parent_report` for you.

## CI export

```bash
review export
review export --file .reviews/<id>-review.json
review export --render-md                       # regenerate .md from JSON first
review export --out ./ci-artifacts --fail-on important
```

Validates the report, prints a summary, optionally copies artefacts and fails on open findings at/above a severity level.

## Project-specific hooks

When reviewing a project that documents accepted risks:

- If the skill’s [reference/accepted-risks.md](reference/accepted-risks.md) (or the project’s ADR digest) applies, inject it into **every scout and skeptic packet**. Full ADRs are the fallback for claims the digest does not cover. Customize `accepted-risks.md` per product as needed.
- Scouts also honor project agent guidelines and any cross-cutting patterns listed in the digest.

## Model selection for subagents

**Choose the model tier per dispatch — never default to the most capable (priciest) model.** Match the tier to the judgment the role actually needs. Map roles to Forge capability tiers (`fast` / `standard` / `capable`) and resolve via `forge resolve-model --tier <…>` so billing stays on the **`included`** (subscription) lane unless the user explicitly asks for metered/API models — see forgekit `docs/forge.md` § Subagent model.

| Role | Tier | Why |
| ---- | ---- | --- |
| Scout (any partition) | `standard` | Checklist-driven scanning; breadth over depth |
| Coverage pass | none (orchestrator-inline) | Bookkeeping over the tentative list; subagent only if the scope is very large |
| Skeptic — `minor` batch | `standard` | Verdicts need judgment, but stakes are low; never the *cheapest* tier |
| Skeptic — `important` | `standard` | Escalate to `capable` only when the claim needs subtle non-local reasoning (races, authz chains, crypto) |
| Skeptic — `critical` | `capable` | A wrong verdict here is the costliest outcome |
| Second opinion (dangerous quadrant) | `capable` | Exists precisely to catch a wrong dismissal |

Honor resolver JSON: if `omitModel` is true, pass no explicit `model` to the Task tool; otherwise pass `model` exactly. Do not invent frontier/API slugs. If the session is *already* on the strongest included model, escalation to `capable` may be a no-op — don't pay for it twice by picking a metered slug.

## Subagent dispatch template

```
Task (generalPurpose or explore):
  Prompt from reference/phase2-skeptic.md with finding packet filled in.
  Model tier per the model-selection table above.
  Read files needed to verify — no session history.
  Return one verdict YAML block per finding in the packet.
```

Dispatch independent scouts and skeptics in parallel; barrier only where you must merge across the whole set (dedupe, coverage).

## Quality bar

Before finishing:

- [ ] Report scaffolded with `review:new` (deterministic id/timestamp/SHAs)
- [ ] Prior-report carry-forward checked; carried verdicts cite the prior report id + SHA
- [ ] Signals pre-flight run; `signals` recorded
- [ ] Scope and lenses recorded
- [ ] Coverage pass run; `coverage` ledger recorded
- [ ] Every tentative finding has a verdict: dedicated skeptic (critical), batched skeptic (important/minor), inline verdict, grounded-skip, or carry-forward; dangerous-quadrant findings got a second skeptic (≤3)
- [ ] Skeptic dispatches stayed within budget (~12 default); model tier chosen per the model-selection table, not defaulted to the most capable
- [ ] `stats` dispatch counters recorded (scouts, skeptics, inline verdicts, skips, carry-forwards)
- [ ] Markdown **generated** via `review:render` (not hand-written)
- [ ] JSON validates via `review export`
- [ ] False positives documented in the appendix with reasons

## Human documentation

- forgekit `docs/thorough-code-review.md` — overview, invocation, CI usage
- project agent docs (if any)

## Additional resources

- [reference/lenses.md](reference/lenses.md) — per-lens checklists
- [reference/signals-preflight.md](reference/signals-preflight.md) — grounding tools → findings
- [reference/phase1-scout.md](reference/phase1-scout.md) — scout prompt (+ partitioning)
- [reference/phase1c-coverage.md](reference/phase1c-coverage.md) — recall / coverage pass
- [reference/phase2-skeptic.md](reference/phase2-skeptic.md) — skeptic prompt (+ risk-weighting)
- [reference/severity-rubric.md](reference/severity-rubric.md) — severity calibration
- [reference/report-template.md](reference/report-template.md) — markdown structure (generated)
- [reference/report-schema.json](reference/report-schema.json) — JSON sidecar schema
- [examples.md](examples.md) — invocation examples
