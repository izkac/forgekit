# Add A Health Endpoint

Update the Node HTTP fixture in `/app` to add `GET /health`.

The new endpoint must:

- Return HTTP status `200`.
- Return the JSON body `{ "ok": true }`.

Preserve the existing behavior of the root route and other routes. Add an
appropriate automated test for the new endpoint, then run the existing test
suite to verify the change.

Do not edit or replace the pre-existing `src/server.test.mjs`; put the required
new coverage in a separate `src/*.test.mjs` file.
