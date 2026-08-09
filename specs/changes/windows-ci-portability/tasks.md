# Tasks

## 1. Path and environment portability

- [x] 1.1 Fix CRLF parsing, absolute ESM import URLs, and HOME/USERPROFILE isolation for the five non-permission Windows failures. Run focused and full Linux tests without changing production behavior.

## 2. Deterministic filesystem failures

- [x] 2.1 Replace the 21 platform-dependent permission/path-error fixtures with deterministic exact fault injection across transcript discovery, metrics/evidence aggregation, census, fleet, review label, and review stamp tests. Preserve the intended EACCES/ENOTDIR fail-closed assertions.

## 3. Matrix verification

- [x] 3.1 Run full tests/lint locally and validate Ubuntu/Windows on Node 20 and 22 in CI. Record exact totals and archive the change only when the matrix is green.
