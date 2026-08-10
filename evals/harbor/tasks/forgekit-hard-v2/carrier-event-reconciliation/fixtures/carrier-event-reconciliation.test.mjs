import assert from "node:assert/strict";
import { test } from "node:test";
import { createApplication } from "./app.mjs";

const dhl = ({ event, id, shipment, sequence, occurredAt }) => ({
  event, event_id: id, tracking_number: shipment, sequence, occurred_at: occurredAt,
});
const fedex = ({ state, id, shipment, sequence, occurredAt }) => ({
  state, id, trackingCode: shipment, providerSequence: sequence, timestamp: occurredAt,
});

class RecordingEventStore {
  constructor(log) { this.log = log; this.items = []; }
  async append(event) {
    this.log.push(["append", event.carrier, event.eventId]);
    const existing = this.items.find((item) => item.carrier === event.carrier && item.eventId === event.eventId);
    if (existing) return { appended: false, event: { ...existing } };
    const stored = { ...event, storedAt: "fixture" };
    this.items.push(stored);
    return { appended: true, event: { ...stored } };
  }
  entries() { return this.items.map((item) => ({ ...item })); }
  size() { return this.items.length; }
}

class RecordingShipmentStore {
  constructor(log) { this.log = log; this.items = new Map(); }
  async project(event) {
    this.log.push(["project", event.carrier, event.eventId]);
    const previous = this.items.get(event.shipmentId);
    const current = { shipmentId: event.shipmentId, carrier: event.carrier, status: event.status,
      sequence: event.sequence, occurredAt: event.occurredAt, eventId: event.eventId };
    this.items.set(event.shipmentId, current);
    return { previous: previous && { ...previous }, current: { ...current } };
  }
  get(id) { const value = this.items.get(id); return value && { ...value }; }
  entries() { return [...this.items.values()].map((item) => ({ ...item })); }
}

test("carrier identity, ordering, terminality, and HTTP composition use recording adapters", async () => {
  const log = [];
  const eventStore = new RecordingEventStore(log);
  const shipmentStore = new RecordingShipmentStore(log);
  const app = createApplication({ eventStore, shipmentStore });
  const dhlPayload = dhl({ event: "in_transit", id: "same-id", shipment: "DHL-GUARD", sequence: 2, occurredAt: "2026-08-10T10:02:00.000Z" });
  const fedexPayload = fedex({ state: "DELIVERED", id: "same-id", shipment: "FEDEX-GUARD", sequence: 9, occurredAt: "2026-08-10T10:09:00.000Z" });
  const first = await app.reconciliationService.reconcile("dhl", dhlPayload);
  const second = await app.reconciliationService.reconcile("fedex", fedexPayload);
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.deepEqual(log.slice(0, 4).map(([kind]) => kind), ["append", "project", "append", "project"]);
  assert.equal(eventStore.size(), 2);
  const duplicate = await app.reconciliationService.reconcile("dhl", dhlPayload);
  assert.equal(duplicate.accepted, false);
  assert.equal(log.length, 4);
  assert.equal(shipmentStore.get("DHL-GUARD").status, "in_transit");

  await app.reconciliationService.reconcile("dhl", dhl({ event: "delivered", id: "newer", shipment: "DHL-LATE-GUARD", sequence: 4, occurredAt: "2026-08-10T10:04:00.000Z" }));
  const late = await app.reconciliationService.reconcile("dhl", dhl({ event: "out_for_delivery", id: "older", shipment: "DHL-LATE-GUARD", sequence: 3, occurredAt: "2026-08-10T10:03:00.000Z" }));
  assert.equal(late.accepted, true);
  assert.deepEqual({ status: shipmentStore.get("DHL-LATE-GUARD").status, sequence: shipmentStore.get("DHL-LATE-GUARD").sequence }, { status: "delivered", sequence: 4 });

  const terminalLate = await app.reconciliationService.reconcile("fedex", fedex({ state: "IN_TRANSIT", id: "terminal-old", shipment: "FEDEX-GUARD", sequence: 8, occurredAt: "2026-08-10T10:08:00.000Z" }));
  assert.equal(terminalLate.accepted, true);
  assert.equal(shipmentStore.get("FEDEX-GUARD").status, "delivered");

  const before = log.length;
  await assert.rejects(() => app.reconciliationService.reconcile("unknown", dhlPayload), (error) => error.code === "unknown_carrier");
  await assert.rejects(() => app.reconciliationService.reconcile("dhl", { event_id: "bad" }), (error) => error.code === "malformed_event");
  assert.equal(log.length, before);

  const server = app.server;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/webhooks/fedex`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fedex({ state: "IN_TRANSIT", id: "http-event", shipment: "HTTP-GUARD", sequence: 1, occurredAt: "2026-08-10T11:00:00.000Z" })),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).accepted, true);
    assert.deepEqual(log.slice(-2).map(([kind]) => kind), ["append", "project"]);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
