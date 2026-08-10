import assert from "node:assert/strict";
import { test } from "node:test";
import { createApplication } from "./app.mjs";
import { MemoryChargeStore } from "./charge-store.mjs";
import { AppendOnlyRefundLedger } from "./refund-ledger.mjs";
import { RecordingRefundGateway } from "./refund-gateway.mjs";
import { RefundError } from "./errors.mjs";

const chargeFixture = { id: "fixture-charge", amountCents: 12_347 };
const refundPlan = [1_203, 2_307, 8_837];

function makeFixture({ gateway } = {}) {
  const chargeStore = new MemoryChargeStore([{ ...chargeFixture }]);
  const ledger = new AppendOnlyRefundLedger();
  const refundGateway = gateway ?? new RecordingRefundGateway();
  const app = createApplication({ chargeStore, ledger, refundGateway });
  return { ...app, charge: chargeStore.get(chargeFixture.id) };
}

function successfulTotal(ledger, chargeId) {
  return ledger.successfulFor(chargeId).reduce((total, entry) => total + entry.amountCents, 0);
}

for (const [name, amountIndex] of [
  ["partial refund", 0],
  ["exact remaining balance", 2],
]) {
  test(`accepts a ${name} and records integer-cent effects`, async () => {
    const fixture = makeFixture();
    const amount = amountIndex === 2
      ? fixture.charge.amountCents - refundPlan[0] - refundPlan[1]
      : refundPlan[amountIndex];
    const result = await fixture.refundService.refund(fixture.charge.id, amount, `boundary-${name}`);
    assert.equal(result.amountCents, amount);
    assert.equal(successfulTotal(fixture.ledger, fixture.charge.id), amount);
    assert.equal(fixture.refundGateway.calls.length, 1);
    assert.deepEqual(fixture.refundGateway.calls[0], {
      chargeId: fixture.charge.id,
      amountCents: amount,
      idempotencyKey: `boundary-${name}`,
    });
  });
}

test("accounts unequal successful refunds cumulatively and rejects a later over-refund", async () => {
  const fixture = makeFixture();
  const first = refundPlan[0];
  const second = refundPlan[1];
  const exactRemaining = fixture.charge.amountCents - first - second;
  await fixture.refundService.refund(fixture.charge.id, first, "cumulative-first");
  await fixture.refundService.refund(fixture.charge.id, second, "cumulative-second");
  await fixture.refundService.refund(fixture.charge.id, exactRemaining, "cumulative-final");
  const over = refundPlan[0];
  await assert.rejects(
    () => fixture.refundService.refund(fixture.charge.id, over, "cumulative-over"),
    (error) => error instanceof RefundError && error.code === "refund_exceeds_charge" && error.status === 409,
  );
  assert.equal(successfulTotal(fixture.ledger, fixture.charge.id), fixture.charge.amountCents);
  assert.equal(fixture.ledger.entries().length, 3);
  assert.equal(fixture.refundGateway.calls.length, 3);
});

test("validation, missing charges, and gateway failures leave refundable balance unconsumed", async () => {
  let calls = 0;
  const gateway = {
    calls: [],
    async refund(request) {
      this.calls.push({ ...request });
      calls += 1;
      if (calls === 1) throw new Error("temporary gateway outage");
      return { refundId: `refund-${calls}`, amountCents: request.amountCents };
    },
  };
  const fixture = makeFixture({ gateway });
  for (const amountCents of [0, -1, 1.25, "1203", Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      () => fixture.refundService.refund(fixture.charge.id, amountCents, `invalid-${String(amountCents)}`),
      (error) => error instanceof RefundError && error.code === "invalid_amount",
    );
  }
  await assert.rejects(
    () => fixture.refundService.refund("missing-charge", refundPlan[0], "missing"),
    (error) => error instanceof RefundError && error.code === "charge_not_found" && error.status === 404,
  );
  await assert.rejects(
    () => fixture.refundService.refund(fixture.charge.id, refundPlan[0], "failed-once"),
    (error) => error instanceof RefundError && error.code === "gateway_failed" && error.status === 502,
  );
  assert.equal(successfulTotal(fixture.ledger, fixture.charge.id), 0);
  assert.equal(fixture.ledger.entries().length, 1);
  assert.equal(fixture.ledger.entries()[0].status, "failed");
  await fixture.refundService.refund(fixture.charge.id, refundPlan[0], "retry-after-failure");
  assert.equal(successfulTotal(fixture.ledger, fixture.charge.id), refundPlan[0]);
  assert.equal(fixture.refundGateway.calls.length, 2);
});

test("successful replay is idempotent and conflicting replay has no effects", async () => {
  const fixture = makeFixture();
  const amount = refundPlan[1];
  const first = await fixture.refundService.refund(fixture.charge.id, amount, "replay-key");
  const replay = await fixture.refundService.refund(fixture.charge.id, amount, "replay-key");
  assert.deepEqual(replay, first);
  assert.equal(fixture.refundGateway.calls.length, 1);
  assert.equal(fixture.ledger.entries().length, 1);
  await assert.rejects(
    () => fixture.refundService.refund(fixture.charge.id, amount + refundPlan[0], "replay-key"),
    (error) => error instanceof RefundError && error.code === "idempotency_conflict" && error.status === 409,
  );
  assert.equal(fixture.refundGateway.calls.length, 1);
  assert.equal(fixture.ledger.entries().length, 1);
});

test("HTTP refund route invokes the injected service and preserves status errors", async () => {
  const fixture = makeFixture();
  const server = fixture.server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const accepted = await fetch(`${base}/charges/${fixture.charge.id}/refunds`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "http-key" },
      body: JSON.stringify({ amountCents: refundPlan[0] }),
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).amountCents, refundPlan[0]);
    const rejected = await fetch(`${base}/charges/${fixture.charge.id}/refunds`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "http-over" },
      body: JSON.stringify({ amountCents: fixture.charge.amountCents }),
    });
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).error, "refund_exceeds_charge");
    assert.equal(fixture.refundGateway.calls.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
