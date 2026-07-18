# Thorough code review

Two-phase agent skill for **deep code review with false-positive filtering**. Use it when you want more than a quick pass — especially security, correctness, and smell checks before merge.

**Skill:** [`skills/thorough-code-review/SKILL.md`](../skills/thorough-code-review/SKILL.md)  
**Install:** `forgekit install --skills thorough-code-review` (or `review install`)  
**CLI:** `review` (part of `@izkac/forgekit`)  
**Reports:** `.reviews/` in the project under review (typically gitignored)

**Not** the same as Forge’s per-task `requesting-code-review` — this skill is **standalone** and invoked explicitly (`disable-model-invocation: true`).

---

## Install

```bash
# Preferred
npm i -g @izkac/forgekit
forgekit install --skills thorough-code-review --agents cursor,claude
# or: review install --cursor --force
```

Copies `skills/thorough-code-review/` → `~/.cursor/skills/thorough-code-review` (and/or Claude / Codex).

---

## When to use

| Situation | Use thorough review? |
| --------- | -------------------- |
| Pre-merge / pre-PR audit | Yes |
| Security-focused pass on a service or file | Yes (`--security`) |
| Re-check after fixing review findings | Yes (`--verify-fixes`) |
| CI gate on a saved report | Yes (`review export`) |
| Quick Forge task checkpoint during `/forge:build` | No — use Forge `requesting-code-review` instead |

---

## How to invoke

Ask the agent explicitly — the skill does **not** auto-load.

**Examples:**

```
Run a thorough code review on my branch
Review src/services/checkout.ts --security
Re-verify the fixes from the last review (--verify-fixes)
```

If you **don't** specify a scope, the agent **must ask** which applies:

| Scope | What gets read |
| ----- | -------------- |
| Uncommitted | `git diff` + untracked files |
| Branch vs main | Full PR-style diff |
| Paths / services | Files or directories you name |
| Commit range | `git diff BASE..HEAD` |
| Single file | Deep read of one file |

---

## Review lenses

Default: **all lenses**. Narrow with flags or plain language:

| Flag | Focus |
| ---- | ----- |
| `--security` | AuthZ, injection, secrets, crypto |
| `--correctness` | Logic, races, edge cases, idempotency |
| `--smells` | Duplication, complexity, dead code |
| `--architecture` | Boundaries, coupling, layering |
| `--performance` | N+1, hot paths, allocations |
| `--tests` | Coverage gaps, mock-heavy tests |
| `--contracts` | OpenAPI drift, breaking API changes |
| `--errors` | Silent failures, error propagation |
| `--maintainability` | Readability, file size |

Checklists live in [`skills/thorough-code-review/reference/lenses.md`](../skills/thorough-code-review/reference/lenses.md).

---

## Workflow

```
Scaffold (review new) → Resolve scope + lenses
  → Carry-forward (review carryforward — inherit prior verdicts for unchanged files)
  → Signals pre-flight (run grounding tools; seed grounded findings)
  → [if smells] Dedupe pre-flight (read-only)
  → Phase 1: Scout — tentative findings (parallel scouts write .reviews/<id>-tentative/*.json;
              review merge dedupes + renumbers)
  → Phase 1.5: Coverage pass — recall: what did the scout miss? (orchestrator-inline; ≤10 follow-ups)
  → Phase 2: Skeptic — severity-routed + budgeted (~12 dispatches default: dedicated per critical;
              batched by file for important/minor; inline verdicts for cheap minors; grounded
              findings below important skip; ≤3 second skeptics for the dangerous quadrant)
  → Phase 3: Synthesis — edit JSON (incl. stats dispatch counters) → review render → review export
```

Orchestration commands: `review carryforward --parent <id> [--file <target>] [--dry-run]` (copies verdicted findings whose file is unchanged since the parent report's SHA) and `review merge --dir .reviews/<id>-tentative` (merge + dedupe + renumber parallel scout outputs). The report JSON accepts an optional `stats` object (scouts, skeptics_dedicated, skeptics_batched, inline_verdicts, grounded_skips, carried_forward, second_opinions) rendered as a "Pipeline stats" line.

### Scaffold first

`review new <slug> --type <branch|paths|…>` writes a schema-valid `.reviews/<id>-review.json` skeleton with the timestamp, review id, scope slug, and git SHAs captured deterministically — never hand-author those.

### Signals pre-flight

`review signals` maps the scope to the workspaces it touches and prints the exact per-workspace `typecheck`/`test`/`lint` commands. Running them turns real tool failures into **grounded** findings (raising recall on smells/contracts/tests) instead of relying on hand-reading alone. The **dedupe pre-flight** (smells lens) is this pattern with a project `dedupe` skill (if available) as the tool.

### Phase 1 — Scout

Discovers **tentative** issues only. Each finding needs `file:line`, a code citation, lens, severity guess, and confidence. Large scopes are **partitioned** across parallel scout subagents (capped at 4 — units grow instead), then merged and de-duplicated.

### Phase 1.5 — Coverage pass

Balances the skeptic's precision with **recall**: which in-scope files got zero findings (clean or skipped?), which active lens produced nothing (real or not exercised?). Emits follow-up findings and a `coverage` ledger.

### Phase 2 — Skeptic

Skeptic subagents receive only their finding packet(s) — no chat history. Dispatch is **severity-routed and budgeted** (default cap ~12 dispatches per review, override with `--budget N` or "no budget"): `critical` findings get a dedicated skeptic each; `important` and `minor` findings sharing a file are batched into one skeptic (independent verdict per finding); `minor` findings with high scout confidence and a self-contained evidence packet are verdicted **inline by the orchestrator** (no subagent); tool-grounded findings below `important` skip the skeptic entirely (the tool output is the proof). Model tiers are chosen per role — the most capable (priciest) model is reserved for `critical` skeptics and second opinions; everything else runs on the default tier (resolve via `forge resolve-model --tier …` when Forge is installed). Each skeptic must:

1. **Steelman** the claim (strongest interpretation).
2. Trace call chains, tests, middleware, ADRs / accepted risks.
3. Return a verdict: `confirmed` | `false_positive` | `downgraded` | `needs_decision`.

**Risk-weighted:** a high-severity finding that one skeptic wants to dismiss (the *dangerous quadrant*) gets a **second independent skeptic** (capped at 3 per review, highest severity first) before it drops to the appendix; a disagreement routes to `needs_decision`. False positives go to the report **appendix**, not the main body.

### Phase 3 — Synthesis

The **JSON is the single source of truth**; the markdown is *generated* from it (`review render`) so the two can't drift. Paired artefacts under **`.reviews/`** (gitignored):

```
.reviews/<timestamp>-<scope-slug>-review.json   # author this
.reviews/<timestamp>-<scope-slug>-review.md      # generated by review render
```

---

## Report layout

### Markdown (human-readable)

1. **Executive summary** — scope, lenses, verdict counts, top 3 actions
2. **Critical / Important / Minor** — only `confirmed` and `downgraded` findings
3. **Needs decision** — architectural or policy items
4. **Coverage ledger** — files reviewed/skipped, lenses with zero findings (from the recall pass)
5. **Appendix A** — rejected false positives (with reasons)
6. **Appendix B** — dedupe pre-flight summary (when smells ran)

Generated by `review render` — do not hand-edit the `.md`.

Template: [`skills/thorough-code-review/reference/report-template.md`](../skills/thorough-code-review/reference/report-template.md)

### JSON (CI / tooling)

Schema: [`skills/thorough-code-review/reference/report-schema.json`](../skills/thorough-code-review/reference/report-schema.json)

Key fields: `review_id`, `kind` (`review` | `reverify`), `scope`, `lenses`, `summary`, `findings[]`, optional `parent_report`, optional `dedupe_preflight`, optional `stats`, optional `coverage`, optional `signals`.

---

## Fix verification (`--verify-fixes`)

After you patch code:

1. Agent loads the prior `*-review.json` (or scaffolds with `review new <slug> --kind reverify --parent <id>`).
2. Re-runs skeptics only on findings that were `confirmed` or `downgraded`.
3. Also scouts the **fix diff** for regressions a per-finding recheck would miss.
4. Writes `*-reverify.md` + `*-reverify.json` with verdicts: `resolved` | `still_open` | `partially_fixed` | `regressed`.

---

## Commands

| Command | Purpose |
| ------- | ------- |
| `review new <slug> --type <t>` | Scaffold a schema-valid report skeleton (id, timestamp, SHAs) |
| `review signals --type branch` | Plan the grounding tools for the scope's workspaces |
| `review carryforward --parent <id>` | Inherit prior verdicts for unchanged files |
| `review merge --dir .reviews/<id>-tentative` | Merge parallel scout tentative JSON |
| `review render --file <json>` | (Re)generate the markdown from the JSON |
| `review export` | Validate + summarize (CI gate) |
| `review install` | Alias → `forgekit install --skills thorough-code-review` |
| `npm test --workspace=@izkac/forgekit` | Run the CLI test suite (includes review scripts) |

## CI export

Validate and package reports without loading the full skill:

```bash
# Latest *-review.json in .reviews/
review export

# Specific report
review export --file .reviews/20260605T161200Z-my-feature-review.json

# Regenerate the markdown from JSON, then validate
review export --render-md

# Fail pipeline on open findings at/above a severity (critical | important | minor)
review export --file .reviews/pr-review.json --fail-on important

# Copy .md + .json to an artefact directory
review export --out ./ci-artifacts/review
```

Implementation: [`packages/cli/src/review/export.mjs`](../packages/cli/src/review/export.mjs)

**GitHub Actions sketch:**

```yaml
- name: Validate code review report
  run: review export --file .reviews/pr-review.json --fail-on critical
```

---

## Project-specific hooks

When reviewing a project that documents accepted risks, inject them into every scout and skeptic packet:

- Project agent docs (`AGENTS.md` or equivalent) — coding guidelines
- ADRs / decision records — accepted risks; do not re-flag as Critical without a re-open trigger
- Skill template: [`reference/accepted-risks.md`](../skills/thorough-code-review/reference/accepted-risks.md)
- Filled Janus example (reference only): [`examples/accepted-risks-janus.md`](../skills/thorough-code-review/examples/accepted-risks-janus.md)

---

## Severity rubric

| Level | Bar |
| ----- | --- |
| **Critical** | Exploitable in production, data loss, auth bypass, money wrong |
| **Important** | Real bug or serious debt with plausible trigger |
| **Minor** | Style, nit, unlikely edge, defense-in-depth |

Full rubric: [`skills/thorough-code-review/reference/severity-rubric.md`](../skills/thorough-code-review/reference/severity-rubric.md)

---

## Examples

Worked examples (invocation phrases, reverify JSON, CI): [`skills/thorough-code-review/examples.md`](../skills/thorough-code-review/examples.md)

---

## Related

| Topic | Path |
| ----- | ---- |
| Forge review (per-task, during `/forge:build`) | [`docs/forge.md`](forge.md) |
| Forgekit install | [`README.md`](../README.md) |
