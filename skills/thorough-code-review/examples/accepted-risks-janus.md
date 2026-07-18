# Accepted risks digest — Janus example

Filled-in digest from the **Janus** monorepo (originating project). Copy patterns into your product's `reference/accepted-risks.md`; do not treat Janus ADRs as applicable outside that repo.

Distilled from `docs/adr/` so review subagents don't re-discover — and don't re-escalate — risks Janus has formally accepted. **Do not flag these as findings** unless a listed re-open trigger has fired; cite the ADR instead. If a claim isn't covered here, check `docs/adr/` before confirming a security finding.

**Maintenance:** update this file whenever an ADR that accepts, changes, or re-opens a risk is created (part of the archive-to-adr step).

## ADR-0048 — inter-service HMAC is LAN-internal (the big one)

The HMAC-gated APIs of CDP, Mercury, and Persona are **never published through Traefik**; all callers are first-party apps on a trusted overlay. Accepted, NOT findings:

- **HMAC signs body only** — no method/path binding, no timestamp/nonce, replayable. Accepted; hardening is formally out of scope.
- **Persona any-app→any-subject profile read/write** — load-bearing (CLM territory assignment, Mercury billing reads); writes are already self-disciplined via session-pinned `:sub` proxies.
- **CDP actor-header trust** — CLM binds actor headers server-side from a signed JWT; CDP resolves the role from its own `users` table. Forging requires the CLM HMAC secret.
- **Mercury VAT reverse-charge** — gated by Mercury's own `vat_verifications` VIES cache (fail-safe to standard VAT); TopBrands server re-verifies at source. Client cannot self-assert `valid`.

**Re-open triggers** (if any is true in the code under review, escalate freely): an HMAC route becomes internet-reachable (Traefik `Host()` router without `PathPrefix`), the overlay becomes untrusted/multi-tenant/unencrypted-sniffable, or a non-first-party app is onboarded.

## Other standing decisions reviews keep tripping on

- **CDP GDPR forget is PII-only** (ADR-0056) — behavioral events survive erasure by design; only PII fields are scrubbed. Not a leak.
- **Redaction contract** (ADR-0058) — loggers censor via `@janus/pii` taxonomy with literal `"[redacted]"`; a field passing through the shared logger is not automatically a PII leak.
- **Stripe card rail: Stripe totals are authoritative** (ADR-0059) — Mercury mirroring Stripe-computed totals on the card rail is intended, not a trust bug.
- **Control Center deploy actions** (ADR-0068/0073) — TEST-channel-only, flag-off by default, confirm+audit, registry-bound argv arrays. The execFile shelling is the reviewed design, not command injection.
- **Cross-rep contact visibility in CLM** — intended product behavior (`all_leads`), not IDOR (ADR-0048 §5 note).

## Cross-cutting patterns to check (not accepted risks — real find material)

- Idempotency middleware must reserve-before-execute and never cache errors.
- Every service keeps an OpenAPI route-parity test alive (mounted routes vs registry).
- Nullable-unique Mongo fields need partial `$type` indexes, not sparse (E11000 class).
