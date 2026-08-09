# Design

## Context

Windows accepts many `chmod` calls but does not enforce POSIX mode bits as access denial, uses CRLF in Git checkouts, requires `file:` URLs for absolute ESM imports, and derives the home directory from `USERPROFILE`. Tests that rely on Unix incidental behavior therefore fail before reaching the actual production assertion.

## Decisions

- Normalize only test parsing boundaries and use `pathToFileURL` when generated JavaScript imports an absolute file.
- Isolate both `HOME` and `USERPROFILE` for default-registry tests.
- Use a test-only exact-method/exact-path filesystem fault seam that throws coded errors and is always restored; never weaken production error handling or treat successful Windows I/O as denial.
- Convert fixtures vertically from low-level transcript reads through discovery, evidence aggregation, census, and advisory write paths.

## Risks / Trade-offs

- Broad monkey-patching could contaminate concurrent tests. Fault injection must be scoped to one process/test and restored in `finally` or use a child preload when the behavior is tested in a child.
- Linux success cannot prove Windows portability; the GitHub matrix is the final acceptance seam.
