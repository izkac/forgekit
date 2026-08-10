import assert from "node:assert/strict";
import { test } from "node:test";
import { createApplication } from "./app.mjs";

const dhl = (event, id, shipment, sequence, occurredAt) => ({ event, event_id: id, tracking_number: shipment, sequence, occurred_at: occurredAt });
const fedex = (state, id, shipment, sequence, timestamp) => ({ state, id, trackingCode: shipment, providerSequence: sequence, timestamp });

test("alternate carrier reconciliation keeps provider history monotonic", async () => {
  const app = createApplication();
  const first = await app.reconciliationService.reconcile("dhl", dhl("in_transit", "alternate-shared", "ALT-DHL", 1, "2026-08-10T08:00:00.000Z"));
  const second = await app.reconciliationService.reconcile("fedex", fedex("DELIVERED", "alternate-shared", "ALT-FEDEX", 7, "2026-08-10T08:07:00.000Z"));
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.equal(app.eventStore.size(), 2);
  await app.reconciliationService.reconcile("dhl", dhl("delivered", "alternate-final", "ALT-LATE", 8, "2026-08-10T08:08:00.000Z"));
  await app.reconciliationService.reconcile("dhl", dhl("out_for_delivery", "alternate-old", "ALT-LATE", 6, "2026-08-10T08:06:00.000Z"));
  assert.equal(app.shipmentStore.get("ALT-LATE").status, "delivered");
});
