# Thorough RE Corpus

## Why

Finding F11 (reopened twice as F3) exists because `THOROUGH_RE` was narrowed
against intuition and measured afterwards — eight of twelve genuinely risky
sentences stopped matching, and hard-wrapped plan prose disarmed the
surviving qualifiers at a line break. The bare `contract` noun is back on
purpose; the missing piece is a durable corpus so the next narrowing cannot
ship without seeing exactly which sentences flip.

## What Changes

- A fixture of real **risky** and **benign** sentences (F11's named examples,
  80-column hard-wrapped forms, ordinary software English, samples from
  `specs/changes/archive/` proposal/design/tasks prose).
- A test that asserts today's `isHighRiskText` classification of every row;
  failure output names each sentence whose side changed.
- No change to `THOROUGH_RE` itself.

## Capabilities

- `pace-signals`: corpus fixture and classification pin for the thorough
  detector (delta: `specs/pace-signals/spec.md`)

## Impact

- Code/tests: `packages/cli/src/fixtures/thorough-re-corpus.json` (new),
  `packages/cli/src/preferences.test.mjs` (or dedicated
  `thorough-re-corpus.test.mjs`), possibly export nothing new beyond using
  existing `isHighRiskText`.
- Findings: F11 stays open (narrowing still not done); record that the
  corpus prerequisite shipped.
- Risk: low — observation fixture only. Out of scope: F55 fixture dedupe,
  actually narrowing `contract`.
