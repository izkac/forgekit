# Fix The Phantom Pagination Page

The dependency-free Node service in `/app` has a real boundary bug in
`GET /items`: because there are exactly six items and the page size is three,
it reports a phantom third page and accepts `?page=3` with an empty result.

Fix the pagination calculation so:

- `?page=2` is the final page and returns items 4–6 with `totalPages: 2`.
- `?page=3` is rejected with the endpoint's existing `400` invalid-page response.
- Existing root, first-page, validation, and missing-route behavior remains stable.

Add a new automated regression test that exercises the exact page boundary.
Do not edit or replace the pre-existing `src/server.test.mjs`; put your new test
in a separate `*.test.mjs` file. Run the complete test suite before finishing.
