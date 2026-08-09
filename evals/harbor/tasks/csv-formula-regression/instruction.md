# Add CSV Formula Boundary Tests And Fix The Regression

The dependency-free Node service in `/app` exposes `GET /export.csv`. Its CSV
quoting handles commas and quotes, but cells that begin with a spreadsheet
formula marker are exported unsafely and may execute when opened in spreadsheet
software.

First add endpoint-level boundary tests that expose the problem, then fix it:

- A cell whose first character is `=`, `+`, `-`, or `@` must be neutralized by
  prefixing a single quote (`'`) before normal CSV quoting is applied.
- Those characters are safe when they occur later in a cell and must not cause
  that cell to be changed.
- Preserve the current CSV header, ordinary values, CSV escaping, content type,
  and missing-route behavior.

Do not edit or replace the pre-existing `src/server.test.mjs`; add your boundary
coverage in a separate `*.test.mjs` file. Run the complete test suite before
finishing.
