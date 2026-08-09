# Eval Live Progress Portable Telemetry

## Why

A real Harbor-backed trial produced no terminal feedback for several minutes because the runner redirected Harbor output and emitted its JSON plan only after completion. The same trial also exposed an absolute checkout path in normalized Forge artifact telemetry, contradicting the portable-provenance contract.

## What Changes

- Emit sanitized trial lifecycle and periodic heartbeat messages on stderr while preserving stdout as one machine-readable JSON plan.
- Add a validated progress interval with a useful default and an opt-out.
- Replace absolute Forge artifact paths in structured telemetry with run-relative locators.
- Add regression coverage and operator documentation for both contracts.

## Capabilities

- `benchmark-harness`: observable long-running trials and portable normalized telemetry.

## Impact

Changes are confined to the evaluation runner, its tests, and evaluation documentation. Existing run plans remain schema-compatible. Progress is diagnostic stderr, not cohort provenance. The Forge artifact summary changes from `artifactPath` to `artifactLocator` before any provider-backed pilot is scaled.
