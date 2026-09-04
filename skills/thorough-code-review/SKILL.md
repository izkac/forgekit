---
name: thorough-code-review
description: >-
  Performs two-phase code review with adversarial false-positive verification across
  security, correctness, smells, architecture, performance, tests, contracts, errors,
  and maintainability. Grounds findings in a signals pre-flight, routes verification by
  severity under a preset budget, and risk-weights the skeptic pass. JSON is the source
  of truth; the Markdown is generated from it. Writes reports to .reviews/. Supports
  presets (quick/standard/deep), lens narrowing, dedupe pre-flight, fix re-verification,
  and CI export. Use when the user asks for code review, thorough review, security
  review, PR review, /review, or --verify-fixes / re-verify findings.
disable-model-invocation: true
---

# Thorough Code Review

Two-phase review: **scout** discovers tentative issues; **skeptic** subagents attempt to disprove the ones that matter. Only verified findings appear in the main report.

Four properties keep it honest **and** affordable:

- **Grounded** — a signals pre-flight runs real tools (typecheck, lint, tests) so findings start from fact, not guesswork.
- **Severity-routed** — adversarial verification is spent where a wrong call is costly. Every preset verifies `critical`; the preset decides how far below that it pays. Findings under that line are reported with the scout's evidence and the verdict `unverified` — surfaced, never silently dropped, never paid for.
- **Budgeted** — a preset fixes the scout cap, the skeptic budget, and the second-opinion cap before the run starts. `review new` prints those numbers; follow them.
- **Risk-weighted** — a `critical` that one skeptic wants to dismiss gets a second, independent skeptic before it vanishes.

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

**Diff scopes are read diff-first.** For `uncommitted`, `branch`, and `commit_range`, the unit of review is the changed hunk plus its enclosing function — not the whole file. Open the rest of a file only when a lens checklist item sends you there (a caller whose contract moved, a guard the diff removed, the type a change depends on). Unchanged code in a touched file is not in scope: it was not written by this change, and reading it is where a diff review turns into an audit. `paths` and `file` scopes are whole-file reads by definition.

## Presets

The preset fixes the run's cost before it starts. `review new` resolves it and **prints the caps — follow them literally**:

| Preset | Lenses | Scouts | Skeptic budget | Verify from | Second opinions |
| ------ | ------ | ------ | -------------- | ----------- | --------------- |
| `quick` | defect (4) | 1 | 3 | `critical` | 0 |
| `standard` | defect (4) | 2 | 6 | `important` | 2 |
| `deep` | all 9 | 4 | 12 | `minor` | 3 |

`--preset auto` (the default) measures the diff: ≤300 changed lines → `quick`, more → `standard`, unmeasurable → `standard`. **`deep` is never automatic** — it is the old full pipeline, and it is a deliberate purchase. Pass `--preset deep` when the user asks for a full audit, or when the change is security-critical and they want everything.

"Verify from" is the lowest severity that earns a skeptic dispatch. Everything below it is reported with verdict `unverified` and the scout's evidence. `critical` is above the line in every preset, and validation refuses an `unverified` critical.

## Lenses

**Default: the four defect lenses** — `security`, `correctness`, `errors`, `contracts`. They find what breaks in production.

The other five — `smells`, `architecture`, `performance`, `tests`, `maintainability` — produce mostly `minor` findings. They are one flag away and off by default:

| Flag | Lens |
| ---- | ---- |
| `--security` | AuthZ, injection, secrets, crypto |
| `--correctness` | Logic, races, edge cases, idempotency |
| `--errors` | Silent failures, propagation |
| `--contracts` | OpenAPI drift, breaking changes |
| `--smells` | Duplication, complexity, dead code |
| `--architecture` | Boundaries, coupling, layering |
| `--performance` | N+1, hot paths, allocations |
| `--tests` | Coverage, mock-heavy tests |
| `--maintainability` | Readability, file size |

`--all-lenses` (or `--preset deep`) runs all nine. Read only matching sections from [reference/lenses.md](reference/lenses.md).

## Workflow overview

```
Scaffold report   → review new <slug> --type <t> [--preset p]   ← prints the caps
Resolve scope + lenses
  → Prior-report carry-forward (inherit verdicts for unchanged code)
  → Signals pre-flight (run grounding tools; seed grounded findings; close clean lenses)
  → [only if --smells] Dedupe pre-flight (read-only)
  → Phase 1: Scout      (diff-first; partition when large; each scout returns its
                         own coverage ledger — there is no separate coverage pass)
  → review merge        (dedupe + renumber + fold the ledgers)
  → Phase 2: Skeptic    (at/above the preset threshold, under its budget; below it →
                         verdict `unverified`; second skeptic for a dismissed critical)
  → Phase 3: Synthesis  (edit JSON → review render → review export)
```

### Scaffold first

Generate the report skeleton up front so the timestamp, review id, scope slug, git SHAs, **and preset** are captured deterministically (never hand-author these):

```bash
review new mercury-vat --type branch
review new persona-profile --type paths --paths services/persona --lenses security,correctness
review new checkout-audit --type branch --preset deep
```

This writes `.reviews/<id>-review.json` with empty findings and prints the dispatch policy. You fill findings into the JSON as you work, then render and export.

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
3. **A green tool closes its lens.** A passing test suite over the scope exercises `tests`; a green typecheck plus a passing route-parity/contract test exercises `contracts`. Record them in the coverage ledger as exercised-by-tool and do not hand-scout those lenses unless the user named one explicitly. A tool that ran and passed is stronger evidence than a scout re-reading the same code.
4. Record what ran in the JSON `signals` object.

Grounded findings below `important` **skip Phase 2** — a compiler or test failure is already tool-proven; the orchestrator just checks it isn't intentional WIP (recent commit message, TODO, user context) and records the verdict directly. Grounded findings at `critical`/`important` still get a skeptic.

#### Dedupe pre-flight (only when `--smells` is explicit)

Not part of a default run. When the user asks for `--smells` (or `--all-lenses` / `--preset deep`):

1. Read the project `dedupe` skill.
2. Run a **read-only** duplicate scan on the review scope only.
3. Emit `dup-###` tentative findings; merge into the Phase 1 list.
4. Include `dedupe_preflight` in JSON and Appendix B in the rendered markdown.
5. **Do not edit code** during review.

### Phase 1 — Scout

Follow [reference/phase1-scout.md](reference/phase1-scout.md).

**Scale by partitioning.** A single scout reading everything degrades on large scopes. When the scope exceeds ~10 files or ~800 changed lines, split it into reviewable units (by module, or by lens) and run **parallel scout subagents** — capped at the preset's scout count; for bigger scopes make the units larger rather than the scout count higher. Each scout writes to `.reviews/<id>-tentative/<scout-name>.json` (`{ "findings": [...], "coverage": {...} }`); then merge deterministically:

```bash
review merge --dir .reviews/<id>-tentative
```

Small scopes stay a single pass (no tentative dir needed) — the single scout is the orchestrator itself when the scope fits in context.

**Each scout returns its own coverage ledger** — the files it read, the files it skipped and why, and which of its lenses came up empty. There is no separate coverage pass: `review merge` folds the ledgers (a file any scout read is never reported skipped; a lens claim is dropped once any scout files under it). The scout that read the code is also the cheapest thing that can say what it did not read.

Follow-ups a scout raises against its own blind spots are capped at **3 per scout** and must be `important` or above — a recall pass that emits minors is buying findings nobody verifies.

Output tentative findings with: `id`, `lens`, `location`, `claim`, `evidence`, `context`, `related`, `tentative_severity`, `confidence`. Calibrate severity using [reference/severity-rubric.md](reference/severity-rubric.md).

### Phase 2 — Skeptic

Dispatch skeptic subagents (Task tool) with **no chat history**, filling [reference/phase2-skeptic.md](reference/phase2-skeptic.md) placeholders. Mode `initial` for full reviews.

**Route by severity — most findings never reach a subagent:**

1. **Below the preset's `verify_from`** — record verdict `unverified` with the scout's evidence and a `verdict_reason` naming the routing rule (e.g. `minor — severity routing: reported unverified, no skeptic dispatched`). Count them in `stats.unverified`. **No dispatch.** Validation refuses `unverified` on a `critical`, so routing can never bury the severity every preset verifies.
2. **Carry-forward** — verdict inherited from a prior report (see above).
3. **Grounded skip** — tool-proven findings below `important` skip Phase 2 (see signals pre-flight).
4. **`critical`** — one **dedicated** skeptic per finding.
5. **`important`** — batch findings sharing a **module** (not merely a file) into one skeptic dispatch, cap ~4 per batch. Every batched skeptic reads once and returns an **independent verdict block per finding** — never let one verdict color another.

**Dispatch budget.** The preset's number, printed by `review new`, counts every skeptic dispatch including second opinions. The user can raise it (`--budget N`) or lift it ("no budget"). When the tentative list would exceed the budget:

1. Sort by severity, then by scout confidence (low confidence first — those need verification most).
2. Batch more aggressively (merge adjacent-module batches) before dropping anything.
3. Never leave a finding without a verdict, and never silently drop one — if the budget genuinely cannot cover an `important` finding, report it `needs_decision` with a reason noting it was not adversarially verified.

**Risk-weighted second opinion.** Spend it only where a wrong dismissal is most costly: a **`critical` finding a single skeptic returned `false_positive`**. Capped at the preset's number, highest severity first. A dismissed `important` does not buy one — it lands in the appendix with the skeptic's reasoning, which is what the appendix is for. If the two skeptics disagree, keep the higher-severity outcome or route to `needs_decision` — never silently drop it.

**Hard rules:**

- Steelman the claim first.
- Every verdict needs `verdict_reason` with evidence.
- `false_positive` findings go to the report appendix, not the main body.

### Phase 3 — Synthesis

**JSON is the single source of truth. The Markdown is generated from it — never hand-author the `.md`.**

1. Fill findings, `summary` (with `headline` and `top_actions`), `coverage`, `signals`, and `stats` (dispatch counters: `scouts`, `skeptics_dedicated`, `skeptics_batched`, `inline_verdicts`, `grounded_skips`, `carried_forward`, `second_opinions`, `unverified`) into the scaffolded `.reviews/<id>-review.json`.
2. Generate the paired markdown: `review render --file .reviews/<id>-review.json`.
3. Validate + summarize: `review export` (add `--fail-on critical|important` for a CI gate).

The summary verdict counts must reconcile with the findings — `review export` rejects a report whose summary disagrees with its own body, so let render/export own the counts.

## Fix verification (`--verify-fixes`)

When the user fixed issues or asks to re-verify:

1. Scaffold a reverify report: `review new <slug> --kind reverify --parent <review_id>`.
2. Load prior report JSON (user path, or latest `*-review.json` in `.reviews/`).
3. Filter findings where prior `verdict` was `confirmed` or `downgraded`. **`unverified` findings are not re-verified** — they were never verified in the first place; carry them forward unchanged, or drop them if the user fixed them.
4. Phase 2 only: skeptics with `MODE=reverify` in [reference/phase2-skeptic.md](reference/phase2-skeptic.md) — same routing, batching, budget, and model tiers as initial mode.
5. Verdicts: `resolved` | `still_open` | `partially_fixed` | `regressed`.
6. Also scout the **fix diff itself** for regressions a per-finding recheck would miss, then `review render` + `review export`.

`review new --kind reverify` sets `kind: reverify` and `parent_report` for you.

## CI export

```bash
review export
review export --file .reviews/<id>-review.json
review export --render-md                       # regenerate .md from JSON first
review export --out ./ci-artifacts --fail-on important
```

Validates the report, prints a summary, optionally copies artefacts and fails on open findings at/above a severity level. `unverified` findings count as open at their own severity, so a gate never passes because verification was skipped.

## Project-specific hooks

When reviewing a project that documents accepted risks:

- If the skill's [reference/accepted-risks.md](reference/accepted-risks.md) (or the project's ADR digest) applies, inject it into **every scout and skeptic packet**. Full ADRs are the fallback for claims the digest does not cover. Customize `accepted-risks.md` per product as needed.
- Scouts also honor project agent guidelines and any cross-cutting patterns listed in the digest.

## Model selection for subagents

**Choose the model tier per dispatch — never default to the most capable (priciest) model.** Match the tier to the judgment the role actually needs. Map roles to Forge capability tiers (`fast` / `standard` / `capable`) and resolve via `forge resolve-model --tier <…>` so billing stays on the **`included`** (subscription) lane unless the user explicitly asks for metered/API models — see forge skill [docs/forge.md](../forge/docs/forge.md) § Subagent model.

| Role | Tier | Why |
| ---- | ---- | --- |
| Scout (any partition) | `standard` | Checklist-driven scanning; breadth over depth |
| Skeptic — `important` batch | `standard` | Escalate to `capable` only when the claim needs subtle non-local reasoning (races, authz chains, crypto) |
| Skeptic — `critical` | `capable` | A wrong verdict here is the costliest outcome |
| Second opinion (dismissed critical) | `capable` | Exists precisely to catch a wrong dismissal |

Honor resolver JSON: if `omitModel` is true, pass no explicit `model` to the Task tool; otherwise pass `model` exactly. Do not invent frontier/API slugs. If the session is *already* on the strongest included model, escalation to `capable` may be a no-op — don't pay for it twice by picking a metered slug.

## Subagent dispatch template

```
Task (generalPurpose or explore):
  Prompt from reference/phase2-skeptic.md with finding packet filled in.
  Model tier per the model-selection table above.
  Read files needed to verify — no session history.
  Return one verdict YAML block per finding in the packet.
```

Dispatch independent scouts and skeptics in parallel; barrier only where you must merge across the whole set (`review merge`).

## Quality bar

Before finishing:

- [ ] Report scaffolded with `review new` (deterministic id/timestamp/SHAs/preset)
- [ ] Preset caps printed by `review new` were respected — scouts, skeptic budget, second opinions
- [ ] Prior-report carry-forward checked; carried verdicts cite the prior report id + SHA
- [ ] Signals pre-flight run; `signals` recorded; green tools credited as lens coverage
- [ ] Scope and lenses recorded; diff scopes read diff-first
- [ ] Coverage ledger recorded (from the scouts, folded by `review merge`)
- [ ] Every tentative finding has a verdict: dedicated skeptic (critical), batched skeptic (important), `unverified` (below `verify_from`), grounded-skip, or carry-forward
- [ ] A dismissed `critical` got a second skeptic (within the preset cap)
- [ ] `stats` counters recorded, including `unverified`
- [ ] Markdown **generated** via `review render` (not hand-written)
- [ ] JSON validates via `review export`
- [ ] False positives documented in the appendix with reasons

## Human documentation

- forgekit `docs/thorough-code-review.md` — overview, invocation, CI usage
- project agent docs (if any)

## Additional resources

- [reference/lenses.md](reference/lenses.md) — per-lens checklists
- [reference/signals-preflight.md](reference/signals-preflight.md) — grounding tools → findings
- [reference/phase1-scout.md](reference/phase1-scout.md) — scout prompt (+ partitioning, coverage ledger)
- [reference/phase2-skeptic.md](reference/phase2-skeptic.md) — skeptic prompt (+ risk-weighting)
- [reference/severity-rubric.md](reference/severity-rubric.md) — severity calibration
- [reference/report-template.md](reference/report-template.md) — markdown structure (generated)
- [reference/report-schema.json](reference/report-schema.json) — JSON sidecar schema
- [examples.md](examples.md) — invocation examples
