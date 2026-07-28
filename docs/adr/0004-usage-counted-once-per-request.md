# 0004. Usage is counted once per request, from the settled line

- **Status:** Accepted
- **Date:** 2026-07-28
- **Area:** session telemetry / metrics
- **Related:** `specs/changes/archive/2026-07-28-session-telemetry/`, [0003](0003-telemetry-reads-host-transcripts.md)

## Context

Claude Code writes **one transcript line per content block** of a single
assistant reply. A reply containing a thinking block, a text block and two tool
calls becomes four `assistant` lines, each repeating the same `requestId`, the
same `message.id`, and the whole `usage` object. Measured on a real transcript:
39 assistant lines for 12 distinct requests.

Two ways to get this wrong, both of which produce numbers that look entirely
plausible downstream:

- **Summing lines** inflates every token figure roughly 3×.
- **Keeping the first line of a request** understates output. The first line
  carries a *preliminary* `output_tokens` (3–7, tagged
  `inference_geo: "not_available"`); the settled figure arrives on a later line.
  Measured across a real corpus: ~8.03M output tokens dropped, **28.6%** of the
  total, affecting 368 of 371 subagent sidecars and 0 of 108 parent transcripts.

The second bug shipped through TDD, self-review and a corpus validation, because
every fixture had been built from the same wrong premise — identical usage on
every line — so the tests could detect inflation but never truncation.

## Decision

1. **One entry per `requestId`.** Fall back to `message.id`, then treat the line
   as its own request. Collapse before summing, never after.
2. **Last line wins** for `usage` and for the scalar fields
   (`model`, `effort`, `version`, `isSidechain`). `timestamp` stays first-seen,
   because a request begins when it begins.
3. **One function owns it.** `usageByRequest` in
   `packages/cli/src/metrics/transcript.mjs` is the only place usage is
   collapsed. Anything that counts tokens outside it reintroduces the risk.
4. **The window filter runs on raw lines, before the collapse**, so a request
   restated across several lines is judged by the lines it actually has in the
   window.
5. **Fixtures must vary usage across the lines of a request.** A fixture with
   identical values on every line cannot distinguish any of the three rules
   above from each other.

The product loop (`specs/changes/…/e2e.json`) asserts a deduped count end to end,
so a regression fails a gate rather than a code review.

## Alternatives considered

- **Sum all lines.** Rejected — ~3× inflation.
- **First line wins.** Rejected — this was the shipped bug; −28.6% output tokens.
- **Max across the lines of a request.** Equivalent in every observed case, but
  it encodes a guess about which line is authoritative rather than the observed
  rule (the host settles the figure and does not revise it downward).
- **Ask the host for totals.** No such surface exists.

## Consequences

- **Positive:** Token figures are correct rather than merely plausible — the
  failure mode here is silent, and no downstream consumer could have caught it.
- **Positive:** A single owner means one place to fix if the host's format changes.
- **Negative:** Requires holding a request's lines until the last one is seen,
  so the collapse is not streaming. Acceptable: the largest transcript observed
  (57.5 MB) parses in ~300 ms / ~230 MB RSS.
- **Neutral:** Requests with neither `requestId` nor `message.id` count once
  each, which is the honest reading of a line that claims no identity.

## References

- Archive: `specs/changes/archive/2026-07-28-session-telemetry/` (design.md,
  finding F4)
- Spec: `specs/specs/session-metrics/spec.md` § "Usage is counted once per request"
- Code: `packages/cli/src/metrics/transcript.mjs` (`usageByRequest`)
- Regression test: `packages/cli/src/metrics/transcript.test.mjs` — 39 lines / 12 requests
