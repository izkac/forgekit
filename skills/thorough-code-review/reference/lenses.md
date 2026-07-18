# Review lenses

Load **only** the sections matching active lenses. Default invocation uses all sections.

**Ground first.** Before hand-reading for any lens, ingest the [signals pre-flight](signals-preflight.md) — typecheck, lint, and test output convert directly into grounded findings (especially for smells, contracts, tests, and errors).

## security

- AuthN/AuthZ: who can call this? Is identity bound to the credential?
- Injection: SQL, NoSQL, command, path, template, XSS (if user-facing output)
- Secrets: hardcoded keys, logs, error messages, env leakage
- Crypto: constant-time compare, algorithm choice, key rotation surface
- Input validation at trust boundaries
- SSRF, open redirects, CORS misconfiguration
- Dependency vulnerabilities in changed manifests (note only; do not auto-audit whole tree unless scope includes lockfiles)
- Example (HMAC): body-only signatures without method/path binding? Idempotency caches errors? Headers outside signed envelope?


## correctness

- Logic errors, off-by-one, wrong operator, inverted conditions
- Null/undefined/empty handling
- Race conditions, check-then-act, missing transactions
- Idempotency and retry semantics
- Money: integer cents, rounding, currency conversion
- Date/time/timezone handling
- Error paths that leave inconsistent state

## smells

**Pre-flight (before this checklist):** the dedupe scan is the smells-lens arm of the [signals pre-flight](signals-preflight.md). Read the project `dedupe` skill and run a **read-only** duplicate scan scoped to the review target. Emit `dup-###` tentative findings; include summary in report appendix. Do not edit code.

Then apply:

- Copy-paste blocks (rule of three)
- Near-identical functions differing only by parameter
- Magic numbers/strings repeated across files
- Dead code, unused exports, unreachable branches
- Overly long functions/files **introduced or grown by this change**
- Parallel switch/if chains that could share structure

## architecture

- Single responsibility per module
- Layer violations (domain importing transport, etc.)
- Coupling across service boundaries
- Hidden dependencies, global mutable state
- Does design match existing patterns in the repo?
- Scope creep beyond stated goal

## performance

- N+1 queries or sequential remote calls in loops
- Unbounded memory (loading full collections)
- Missing indexes for new query patterns
- Hot-path allocations or sync I/O
- Missing pagination on list endpoints

## tests

- Do tests assert behaviour, not implementation details?
- Mock-heavy tests that don't catch real regressions
- Missing cases for new branches or error paths
- Flaky patterns (timing, ordering assumptions)
- Integration coverage where unit tests insufficient
- Tests excluded from runner (wrong vitest `include` path)

## contracts

- OpenAPI/registry drift vs mounted routes
- Breaking API or shared package export changes
- Versioning and migration notes
- Client packages updated when server contract changes

## errors

- Swallowed errors (empty catch, ignored return)
- Wrong error type or status code mapping
- Leaking internal details to clients
- Missing error logging with correlation context

## maintainability

- Naming clarity and consistency with codebase
- Comment quality (why, not what)
- File organization and import hygiene
- Type safety gaps (if typed language)
- Documentation for non-obvious public behaviour

## Project hooks (all lenses)

When reviewing a project with agent docs / ADRs:

1. Read project agent instructions (`AGENTS.md` or equivalent) for coding guidelines
2. Check ADRs / [accepted-risks.md](accepted-risks.md) before confirming security findings
3. Note cross-package impact if shared libraries change
