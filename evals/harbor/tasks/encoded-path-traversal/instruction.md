# Harden Encoded File Paths

The dependency-free Node HTTP server in `/app` serves files from its `public`
directory, but its current path handling permits encoded and double-encoded
path traversal.

Harden the file-serving route so requests cannot escape the public directory.
Treat plain, percent-encoded, double-encoded, absolute, and backslash traversal
attempts as missing files without disclosing files outside `public`. Preserve
the existing successful public-file responses and missing-file behavior,
including legitimate encoded filenames. Add an automated security regression
test covering traversal, then run the existing test suite.

Do not edit or replace the pre-existing `src/server.test.mjs`; put the required
new coverage in a separate `src/*.test.mjs` file.
