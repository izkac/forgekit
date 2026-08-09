# Wire Order Creation To The Audit Sink

The dependency-free Node HTTP app in `/app` has a broken `POST /orders`
integration. Its order service needs both the supplied order store and the
supplied audit sink, but the HTTP composition root does not wire both adapters.

Fix the create-order path so that a valid request:

- persists `{ sku, quantity }` through the configured order store;
- appends exactly one audit entry after persistence with
  `{ action: "order.created", orderId, sku }`; and
- returns the saved order as JSON with HTTP status `201`.

Keep the existing root, validation, and not-found behavior. Do not replace the
injected adapters or duplicate their work in the HTTP handler. Add an automated
HTTP-level test that supplies recording adapters and proves both effects occur
in persistence-then-audit order, then run the existing test suite.

Do not edit or replace the pre-existing `src/server.test.mjs`; put the required
new coverage in a separate `src/*.test.mjs` file.
