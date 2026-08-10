import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createApplication } from "./app.mjs";
import { MemoryChargeStore } from "./charge-store.mjs";
import { RefundError } from "./errors.mjs";
import { RecordingRefundGateway } from "./refund-gateway.mjs";
import { AppendOnlyRefundLedger } from "./refund-ledger.mjs";
import { RefundService } from "./refund-service.mjs";

const openServers = new Set();

afterEach(async () => {
  await Promise.all([...openServers].map((server) => new Promise((resolve) => server.close(resolve))));
  openServers.clear();
});

function makeService({ amountCents = 10_000, gateway } = {}) {
  const chargeStore = new MemoryChargeStore([{ id: "charge-1", amountCents }]);
  const ledger = new AppendOnlyRefundLedger();
  const refundGateway = gateway ?? new RecordingRefundGateway();
  const service = new RefundService({ chargeStore, ledger, refundGateway });
  return { chargeStore, ledger, refundGateway, service };
}

const boundaryCases = [
  { name: "accepts a positive partial refund", amount: (charge) => Math.floor(charge.amountCents / 4) },
  { name: "accepts the exact original charge at the boundary", amount: (charge) => charge.amountCents },
];

for (const { name, amount } of boundaryCases) {
  test(name, async () => {
    const fixture = makeService();
    const charge = fixture.chargeStore.get("charge-1");
    const requested = amount(charge);

    const result = await fixture.service.refund(charge.id, requested, "boundary-key");

    assert.equal(result.amountCents, requested);
    assert.equal(fixture.refundGateway.calls.length, 1);
    assert.equal(fixture.ledger.successfulFor(charge.id).length, 1);
    assert.equal(fixture.ledger.successfulFor(charge.id)[0].amountCents, requested);
  });
}

test("rejects invalid amounts before gateway or ledger effects", async () => {
  const fixture = makeService();
  const invalidAmounts = [0, -1, 1.5, "100"];

  for (const amountCents of invalidAmounts) {
    await assert.rejects(
      fixture.service.refund("charge-1", amountCents, `invalid-${String(amountCents)}`),
      (error) => error instanceof RefundError && error.code === "invalid_amount"
    );
  }
  assert.equal(fixture.refundGateway.calls.length, 0);
  assert.equal(fixture.ledger.entries().length, 0);
});

test("preserves not-found behavior without effects", async () => {
  const fixture = makeService();

  await assert.rejects(
    fixture.service.refund("missing", 100, "missing-key"),
    (error) => error instanceof RefundError && error.code === "charge_not_found" && error.status === 404
  );
  assert.equal(fixture.refundGateway.calls.length, 0);
  assert.equal(fixture.ledger.entries().length, 0);
});

test("records gateway failure for audit without consuming refundable balance", async () => {
  const gateway = new RecordingRefundGateway({ failuresRemaining: 1 });
  const fixture = makeService({ gateway });
  const charge = fixture.chargeStore.get("charge-1");

  await assert.rejects(
    fixture.service.refund(charge.id, charge.amountCents, "failed-key"),
    (error) => error instanceof RefundError && error.code === "gateway_failed" && error.status === 502
  );
  assert.equal(fixture.ledger.entries()[0].status, "failed");
  assert.equal(fixture.ledger.successfulFor(charge.id).length, 0);

  const result = await fixture.service.refund(charge.id, charge.amountCents, "retry-key");
  assert.equal(result.amountCents, charge.amountCents);
  assert.equal(gateway.calls.length, 2);
});

test("replays a successful key and rejects a different amount before effects", async () => {
  const fixture = makeService();
  const charge = fixture.chargeStore.get("charge-1");
  const requested = Math.floor(charge.amountCents / 5);
  const first = await fixture.service.refund(charge.id, requested, "same-key");

  const replay = await fixture.service.refund(charge.id, requested, "same-key");
  assert.deepEqual(replay, first);
  assert.equal(fixture.refundGateway.calls.length, 1);
  assert.equal(fixture.ledger.entries().length, 1);

  await assert.rejects(
    fixture.service.refund(charge.id, requested + 1, "same-key"),
    (error) => error instanceof RefundError && error.code === "idempotency_conflict"
  );
  assert.equal(fixture.refundGateway.calls.length, 1);
  assert.equal(fixture.ledger.entries().length, 1);
});

test("HTTP refund route composes RefundService with injected stores, ledger, and gateway", async () => {
  const chargeStore = new MemoryChargeStore([{ id: "http-charge", amountCents: 4_000 }]);
  const ledger = new AppendOnlyRefundLedger();
  const refundGateway = new RecordingRefundGateway();
  const app = createApplication({ chargeStore, ledger, refundGateway });
  const server = app.server.listen(0);
  openServers.add(server);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/charges/http-charge/refunds`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "http-key" },
    body: JSON.stringify({ amountCents: 1_000 }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.amountCents, 1_000);
  assert.equal(refundGateway.calls.length, 1);
  assert.equal(ledger.successfulFor("http-charge").length, 1);
});
