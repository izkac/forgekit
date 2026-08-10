import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createApplication } from "./app.mjs";
import { CarrierEventError } from "./errors.mjs";
import { AppendOnlyEventStore } from "./event-store.mjs";
import { ShipmentProjectionStore } from "./shipment-store.mjs";

const openServers = new Set();

afterEach(async () => {
  await Promise.all([...openServers].map((server) => new Promise((resolve) => server.close(resolve))));
  openServers.clear();
});

function makeApplication() {
  const eventStore = new AppendOnlyEventStore();
  const shipmentStore = new ShipmentProjectionStore();
  const app = createApplication({ eventStore, shipmentStore });
  return { ...app, eventStore, shipmentStore };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  openServers.add(server);
  return server.address().port;
}

async function post(port, carrier, body) {
  const response = await fetch(`http://127.0.0.1:${port}/webhooks/${carrier}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("normalizes and projects a DHL delivery through the application", async () => {
  const fixture = makeApplication();
  const result = await fixture.reconciliationService.reconcile("dhl", {
    event: "in_transit",
    tracking_number: "DHL-42",
    event_id: "dhl-1",
    sequence: 1,
    occurred_at: "2026-08-10T10:00:00.000Z",
  });

  assert.equal(result.accepted, true);
  assert.equal(result.event.carrier, "dhl");
  assert.equal(result.event.shipmentId, "DHL-42");
  assert.equal(fixture.eventStore.entries().length, 1);
  assert.equal(fixture.shipmentStore.get("DHL-42").status, "in_transit");
});

test("normalizes a FedEx payload shape and treats duplicate delivery as idempotent", async () => {
  const fixture = makeApplication();
  const payload = {
    id: "fx-1",
    trackingCode: "FX-77",
    state: "OUT_FOR_DELIVERY",
    providerSequence: 3,
    timestamp: "2026-08-10T11:00:00.000Z",
  };

  const first = await fixture.reconciliationService.reconcile("fedex", payload);
  const second = await fixture.reconciliationService.reconcile("fedex", payload);

  assert.equal(first.accepted, true);
  assert.equal(second.accepted, false);
  assert.equal(second.reason, "duplicate");
  assert.equal(fixture.eventStore.entries().length, 1);
  assert.equal(fixture.shipmentStore.get("FX-77").status, "out_for_delivery");
});

test("HTTP webhook composes the configured normalizer and reconciliation service", async () => {
  const fixture = makeApplication();
  const port = await listen(fixture.server);
  const result = await post(port, "dhl", {
    event: "delivered",
    tracking_number: "DHL-HTTP",
    event_id: "http-1",
    sequence: 4,
    occurred_at: "2026-08-10T12:00:00.000Z",
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.accepted, true);
  assert.equal(fixture.shipmentStore.get("DHL-HTTP").status, "delivered");
  assert.equal(fixture.eventStore.entries().length, 1);
});

test("unknown carriers and malformed payloads fail before any store write", async () => {
  const fixture = makeApplication();
  await assert.rejects(
    fixture.reconciliationService.reconcile("unknown", { event_id: "x" }),
    (error) => error instanceof CarrierEventError && error.code === "unknown_carrier",
  );
  await assert.rejects(
    fixture.reconciliationService.reconcile("dhl", { event: "in_transit" }),
    (error) => error instanceof CarrierEventError && error.code === "malformed_event",
  );
  assert.deepEqual(fixture.eventStore.entries(), []);
  assert.deepEqual(fixture.shipmentStore.entries(), []);
});
