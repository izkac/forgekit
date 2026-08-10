# Repair Carrier Event Reconciliation

The dependency-free Node 22 shipment service in `/app` receives webhook events from
multiple carriers. It has configured carrier-specific normalizers, an append-only
event store, a shipment projection store, a reconciliation service, and a local HTTP
webhook endpoint. The seeded implementation handles ordered events from one carrier,
but its event identity and projection ordering are intentionally unsafe.

Repair the production code so that:

- each configured carrier payload is normalized into one canonical event shape;
- event identity is the pair `(carrier, eventId)`, so equal provider IDs from different
  carriers are independent events;
- an accepted normalized event is appended exactly once before its shipment projection
  is updated;
- duplicate delivery is idempotent and causes no second append or projection effect;
- older events remain recorded but cannot regress a newer shipment projection, using the
  provider sequence and occurred-at values rather than wall-clock arrival;
- `delivered` is terminal and cannot be replaced by a late non-terminal event; and
- unknown carriers and malformed payloads fail before either store is written.

First add a separate HTTP-level or service-level integration test with recording
adapters/stores. The test must prove carrier-scoped deduplication and append-before-
project effects using at least two genuinely different payload shapes, then repair the
real composition path. Keep the task sequential and deterministic. The protected
visible tests in `src/reconciliation.test.mjs` cover only safe baseline behavior and
must not be replaced or edited to embed the collision/late-event sequence.

Run the visible suite with `npm test` from `/app`. Do not add verifier, oracle,
manifest, shared-smoke, v1, or documentation files.
