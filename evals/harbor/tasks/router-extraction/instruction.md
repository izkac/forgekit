# Extract The HTTP Router

Refactor the dependency-free Node HTTP app in `/app` so route matching and
route responses live in a new `src/router.mjs` module rather than in
`src/server.mjs`. The server module must import and use a router exported by
that file while retaining server creation and startup responsibilities.

Preserve these exact existing behaviors:

- `GET /` returns `router-fixture\n` as plain text;
- `GET /status` returns `{ "status": "ready" }` as JSON; and
- unmatched routes return `Not found\n` with status `404` as plain text.

Add parameterized `GET /items/:itemId` routing. It must match exactly one
non-empty path segment, percent-decode that segment, and return status `200`
with the JSON body `{ "itemId": decodedItemId }`. Other methods and
`/items`, `/items/`, or additional path segments remain unmatched.

Add an automated test for the parameterized route (including a percent-encoded
ID), then run the existing test suite.

Do not edit or replace the pre-existing `src/server.test.mjs`; put the required
new coverage in a separate `src/*.test.mjs` file.
