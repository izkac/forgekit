# Windows CI Portability

## Why

The supported Windows/Node 20 and 22 CI jobs consistently fail 26 tests even though the same production behavior passes on Ubuntu. The failures come from POSIX-only test fixtures, CRLF parsing, filesystem paths embedded as ESM specifiers, and incomplete Windows home isolation. This leaves the matrix permanently red and hides future regressions.

## What Changes

- Make text and generated-module fixtures portable across LF/CRLF and file-URL rules.
- Isolate Windows home-directory behavior without touching the runner profile.
- Replace permission-bit assumptions with deterministic, narrowly targeted filesystem fault injection while preserving production fail-closed assertions.
- Validate the complete Node 20/22 Ubuntu/Windows matrix.

## Capabilities

- `project-wiring`: Require the declared CI matrix to run portable tests and report zero unexplained failures.

## Impact

Primarily test fixtures and test-only helpers under `packages/cli/src/`; production behavior must not be weakened to make Windows green. The historical 26-failure baseline is the external RED evidence.
