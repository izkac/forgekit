# Eval Local Checkout

## Why

The evaluator can currently install only a published `@izkac/forgekit` semantic version. That prevents the benchmark from measuring the exact local checkout under development and encourages publishing before Docker/Harbor validation is complete.

The treatment must remain reproducible: a machine-local path alone is not evidence of what entered the Forge image. The runner therefore needs to package the explicitly selected local package, bind the treatment to the resulting archive digest, and record that provenance in every plan and trial manifest.

## What Changes

- Add a mutually exclusive `--forgekit-tarball <path>` input alongside `--forgekit-version`.
- Accept an operator-built local Forgekit tarball, snapshot and hash its exact bytes, and stage a runner-named digest-bound copy only in the Forge arm's Docker build context. The runner never publishes and never executes packaging lifecycle scripts.
- Make the Forge Dockerfile verify and install that tarball while the baseline remains Forge-free.
- Record treatment kind and authoritative SHA-256 digest in the plan and each trial manifest.
- Document and smoke-test a current-checkout workflow without publishing a new package.

## Capabilities

- `benchmark-harness`: Add provenance-bound local-package treatment while preserving the published-version path and external verifier boundary.

## Impact

Affected areas are `evals/harbor/run.mjs`, runner/smoke tests, and evaluator/operator documentation. Operators create the tarball explicitly with `npm pack`; the runner must reject ambiguous inputs, missing/non-file archives, unsafe metadata, and shell interpolation. Existing published-version invocations remain compatible.
