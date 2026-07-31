# Findings Ledger Routing

## Why

The ledger is write-heavy and choice-blind: agents file findings but nothing
surfaces the important open bugs when the next piece of work is chosen. Easy
items get picked; residue calcifies. After kinds/reopen (W2–W4), the missing
loop is advisory routing at `forge new` and age on `forge status`, plus the
rules written where agents actually read them (W7).

## What Changes

- `forge new <slug>` includes open **bugs** whose `change` or text matches the
  slug (token match), as `relatedFindings` in the JSON (and a stderr notice).
  Informational only — never blocks session creation.
- `forge status` gains `staleFindings`: open bugs older than 7 days (`id`,
  `ageDays`, `text`).
- Guardrails + usage/forge docs: fix-beats-file, required kind/severity,
  re-check dependents, never narrow a heuristic without a corpus.

## Capabilities

- `findings-ledger`: related/stale surfacing + agent-facing rules
  (delta: `specs/findings-ledger/spec.md`)

## Impact

- Code: `findings.mjs` (match/stale helpers), `new-session.mjs`,
  `session-status.mjs`, tests.
- Docs: `skills/forge/SKILL.md`, `docs/usage.md`, `skills/forge/docs/forge.md`.
- No new gates. Risk: low.
