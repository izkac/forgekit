# Findings Ledger Kinds

## Why

The open-findings headline has never meant "open bugs." On 2026-07-31 the
ledger read 26 open / 45 resolved with 24 of 26 marked `major` — almost all
because `addFinding` defaults severity, not because anyone judged them.
Bugs, tech debt, accepted trade-offs, improvement ideas and process notes
share one count; that count gets read as a bug count. Separately, findings
cannot reference each other, so when F12's dispatch stamp shipped, F18 and
F19 stayed open past their root cause until a hand audit (W1) closed them —
and "REOPENED" is still a convention inside the text, typographically
identical to an idea. The invariant to restore: *the headline number must
be countable defects that are still true.*

Measured analysis and rules of engagement live in
`docs/plans/2026-07-31-findings-ledger-convergence.md` (W2–W4 of that plan).

## What Changes

- Findings gain a required **`kind`**: `bug | debt | tradeoff | idea | process`.
  `forge finding add` refuses without `--kind` (error names the five).
- **`--severity` required** (or the call fails). Drop `opts.severity ?? 'major'`.
- `forge finding list` defaults to open **bugs**; shows kind; footer states how
  many non-bug opens are hidden and how to see them (`--all-kinds`).
- `forge status`'s `openFindings.count` counts **bugs only**; JSON gains
  `openFindings.byKind`.
- Optional **`dependsOn: string[]`**; `--depends-on` on add; `forge finding
  link <id> --depends-on <ids>`; on resolve, print open dependents under
  `Re-check these — their root cause just closed:` (loud, exit 0, no
  auto-resolve). Backfill known edges F11 → F12 (F18/F19 already resolved).
- Structured **reopen**: `forge finding reopen <id> --from <oldId> --note
  "…"`; fields `reopenedFrom`, `reopenCount`; list marks and sorts them first;
  status names any with `reopenCount >= 1` in its own field; `reopenCount >= 2`
  blocks `forge phase done` on a change that touches the finding's subject
  unless waived (same precedent as `--final-review-waived`).
- One-shot backfill of existing `.forge/findings.jsonl` rows with `kind`
  (and reopen metadata for F11/F13); script under `scripts/`, run, delete.

## Capabilities

- `findings-ledger`: kind, severity discipline, dependsOn, reopen, status
  surfacing (delta: `specs/findings-ledger/spec.md`)

## Impact

- Code: `packages/cli/src/findings.mjs`, `findings-cli.mjs`, `findings.test.mjs`,
  `session-status.mjs`, `set-phase.mjs` (reopen gate).
- Docs deferred to plan W7 (follow-up change) except what tests/CLI usage
  strings must say for the new flags to be usable.
- Out of scope here: W5 THOROUGH_RE corpus, W6 `forge new` routing, W7 skill
  guardrails — separate changes.
- Migration: local ledger only (`.forge/` gitignored). No shipped digests
  change shape.
- Risk: medium — CLI contract change for agents that file findings; reopen
  gate is the only new refusal (one is enough to evaluate).
