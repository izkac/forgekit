# Signals pre-flight

Ground the scout in real tool output **before** reading code by hand. Tool-confirmed problems are facts, not guesses — they raise recall on the smells / contracts / tests / errors lenses and cut hallucinated findings.

## Steps

1. **Plan the commands.** Run the planner for the review scope:

   ```bash
   review signals --type branch          # detect changed files vs main
   review signals --type uncommitted      # working tree + untracked
   review signals --paths services/persona,services/mercury
   review signals --json                  # machine-readable
   ```

   It maps the scope to the **workspaces that own it** and prints the exact per-workspace grounding commands (this monorepo has no root typecheck — each package owns its scripts).

2. **Run the grounding commands** it lists, e.g.:

   ```bash
   npm run typecheck --workspace=your-workspace
   npm run test --workspace=your-workspace
   npm run lint --workspace=your-workspace
   ```

   Add, when available and relevant to the scope:

   - `npx knip` (or the repo's dead-code script) — unused exports / dead code → **smells**
   - the service's OpenAPI **route-parity** test — mounted routes vs registry → **contracts**

3. **Convert real failures to grounded tentative findings.** A type error, failing test, lint error, or dead export becomes an `F-###` (or `dup-###`) tentative finding with `confidence: high` and the tool output as `evidence`. Do **not** invent findings the tools did not support.

4. **Record what ran** in the report JSON `signals` object so the grounding is auditable:

   ```json
   "signals": {
     "tools": [
       { "name": "typecheck your-workspace", "status": "pass" },
       { "name": "test your-workspace", "status": "fail", "summary": "1 failing: consent.test.ts" },
       { "name": "knip", "status": "skipped", "summary": "not in scope" }
     ]
   }
   ```

## Rules

- Read-only. The pre-flight never edits code.
- Scope-bound. Run tools for the **workspaces in scope**, not the whole repo, unless the scope is repo-wide.
- A passing tool is signal too — it lets the coverage pass mark a lens genuinely exercised.
- If a tool can't run (missing script, environment), record it `skipped` with a reason rather than omitting it.

## Notes

- The **dedupe pre-flight** (smells lens) is the same pattern with the `dedupe` skill as the tool; keep emitting `dup-###` findings and the `dedupe_preflight` summary.
- Grounded findings at `critical`/`important` still go through Phase 2 — a failing test might be an intentional WIP. Below `important`, skip the skeptic: the tool output is the proof; the orchestrator just checks for intentional-WIP signals (commit message, TODO, user context) and records the verdict directly.
