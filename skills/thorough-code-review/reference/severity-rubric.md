# Severity rubric

Calibrate severity before Phase 2. Skeptics may **downgrade** with evidence; upgrade only with new evidence.

## Critical

Must fix before merge or production. Examples:

- Exploitable auth bypass or IDOR on production path
- SQL/command injection with attacker-controlled input reaching sink
- Secret or credential committed or logged
- Data loss, corruption, or double-charge on money paths
- Broken idempotency causing duplicate financial side effects

## Important

Should fix soon; real defect or serious debt with plausible trigger. Examples:

- Logic bug on common edge case (empty input, race under concurrency)
- Missing authorization on sensitive internal endpoint (if not ADR-accepted)
- Error responses cached by idempotency middleware
- Test gap on behaviour-critical path
- Significant duplication that must stay in sync (rule of three)

## Minor

Nice to have; low likelihood or defense-in-depth. Examples:

- Naming inconsistency
- Missing progress indicator
- Unlikely edge case with graceful degradation
- Style nits not affecting behaviour
- Pre-existing file size (only flag growth **this change** introduced)

## Needs decision (not a severity)

Architectural or policy trade-off — route to `NEEDS_DECISION` verdict, not Critical by default.

Examples: accepted inter-service trust model per ADR, intentional public surface, documented technical debt.

## Project-specific downgrades

Before marking Critical/Important on themes covered by the project's accepted-risk digest, read that digest (and ADRs):

- Formally accepted trust boundaries (e.g. LAN-only HMAC)
- Documented intentional broad access patterns
- Actor/header trust models bound by an upstream session

Re-flag only if a listed re-open trigger has fired. See [accepted-risks.md](accepted-risks.md) and [examples/accepted-risks-janus.md](../examples/accepted-risks-janus.md).
