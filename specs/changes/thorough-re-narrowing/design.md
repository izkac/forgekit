# Design

## Context

Corpus on disk pins today's classifications. Measurement (2026-07-31) of the
proposed regex against all 21 rows:

- All six F11 risky + hard-wrap rows stay **risky** (0.3.24 left them benign).
- Exactly one flip: `arch-never-block-contract` risky → benign.
- Rows with `public`/`CLI` + contract stay risky (accepted residual).

Brainstorm:
`.forge/sessions/20260731T203646Z-thorough-re-narrowing-7f6a35/brainstorm/`.

## Decisions

- **D1 — Qualifier list + `\s+`.** Include `public|data|api|openapi|cli|wire|schema|smart|service|breaking|interface` before `contracts?`, and keep `contracts?\s+(?:test|tests|testing|breach)`. Drop bare `contract|contracts`.
- **D2 — Deliberate corpus expect update** for the one measured flip.
- **D3 — Rewrite the preferences.test.mjs “unqualified contract” pin** to the new fail-closed-on-real-risk / fail-open-on-bare-noun policy.

## Risks

- A risky sentence that says only “the contract” with no qualifier will no
  longer escalate — accepted; money/auth/migration words still catch the
  floor, and fail-closed prefers missing a bare noun over over-escalating
  every “calling convention” sentence.
- Residual: “public contract of this helper” still matches.

## Migration

None. Resolve F11 on ship.
