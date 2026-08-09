# Design

## Context

A Harbor task Dockerfile can only `COPY` files inside its build context. Installing the current checkout by absolute host path would be non-portable and would leave manifests unable to prove which bytes were evaluated. Installing from the npm registry would continue measuring the released package rather than current source.

## Decisions

- Decision: Add `--forgekit-tarball <path>` and require exactly one treatment selector: local tarball or `--forgekit-version`.
  - Alternatives considered: silently defaulting to the repository checkout; accepting a generic npm package/source spec; making the runner invoke `npm pack` over an arbitrary directory.
  - Rationale: an explicit tarball is the smallest immutable trust boundary. The operator chooses when to run the checkout's packaging lifecycle, while the runner only snapshots bytes and never publishes.

- Decision: Resolve the tarball as a regular file, read its bytes once, compute SHA-256 over that snapshot, and copy it to the Forge environment context under the runner-owned name `forgekit-treatment-<digest>.tgz`.
  - Alternatives considered: preserving the user filename; recording only Git HEAD or package version.
  - Rationale: source paths and names are mutable and potentially unsafe. The digest binds the manifest to exactly what Docker installs, including dirty local content packaged by the operator.

- Decision: Make the Forge Dockerfile copy the digest-named artifact, verify it with `sha256sum --check --strict`, install it globally with npm using `--ignore-scripts --no-audit --no-fund`, and remove the temporary file. No user-controlled value reaches a shell command except the runner-computed lowercase hex digest.

- Decision: Record a structured treatment object in the plan and every trial manifest while retaining `forgekitVersion` for published-version compatibility and setting it to `null` for local tarballs.
  - Local provenance contains `kind: local-tarball`, SHA-256, byte size, and staged filename. The operator's absolute source path is not recorded because it is non-portable and may leak host information.

- Decision: Keep the tarball out of the baseline arm, verifier, and canonical task. Existing published-version smoke behavior remains compatible; a local dry-run test verifies treatment isolation and provenance.

## Risks / Trade-offs

- SHA-256 proves payload identity, not safety. The Docker install disables lifecycle scripts and documentation still requires a trusted operator-built tarball. A Docker smoke must prove the packaged Forge CLI works with lifecycle scripts disabled.
- `npm pack` refreshes vendored assets through this repository's prepack script. Documentation makes that explicit and keeps packaging outside runner execution.
- The Forge tarball digest does not pin registry-resolved transitive dependencies. Manifests must not claim the complete image is bit-reproducible until dependencies are bundled or lock-pinned.
- This change proves payload staging and Docker installation only; model/provider execution remains a separate operational step.
