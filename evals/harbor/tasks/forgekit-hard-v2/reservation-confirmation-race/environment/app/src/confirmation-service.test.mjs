import assert from "node:assert/strict";
import { test } from "node:test";

import { ManualClock } from "./clock.mjs";
import { ConfirmationService } from "./confirmation-service.mjs";
import { createHttpServer } from "./http-app.mjs";
import { MemoryReservationStore } from "./reservation-store.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function fixture({ now = 900, expiresAt = 1000, gateway } = {}) {
  const clock = new ManualClock(now);
  const reservationStore = new MemoryReservationStore([{
    id: "reservation-1", amount: 4200, expiresAt
  }]);
  const paymentGateway = gateway ?? {
    calls: [],
    async charge(input) {
      this.calls.push(input);
      return { paymentId: `pay-${this.calls.length}` };
    }
  };
  const service = new ConfirmationService({ reservationStore, paymentGateway, clock });
  return { clock, reservationStore, paymentGateway, service };
}

/* BEGIN PRE-EXISTING VISIBLE TESTS */
test("a completed confirmation is replayed for the same idempotency key", async () => {
  const { service, paymentGateway } = fixture();
  const first = await service.confirm("reservation-1", "request-17");
  const replay = await service.confirm("reservation-1", "request-17");

  assert.deepEqual(replay, first);
  assert.equal(first.status, "confirmed");
  assert.equal(first.paymentId, "pay-1");
  assert.equal(paymentGateway.calls.length, 1);
  await assert.rejects(
    service.confirm("reservation-1", "different-request"),
    (error) => error.code === "already_confirmed"
  );
});

test("the expiration instant is closed to new confirmations", async () => {
  const { service, paymentGateway } = fixture({ now: 1000, expiresAt: 1000 });
  await assert.rejects(
    service.confirm("reservation-1", "at-deadline"),
    (error) => error.code === "expired" && error.status === 410
  );
  assert.equal(paymentGateway.calls.length, 0);
});

test("expiry is an admission deadline, not a late completion deadline", async () => {
  const entered = deferred();
  const release = deferred();
  const gateway = {
    calls: [],
    async charge(input) {
      this.calls.push(input);
      entered.resolve();
      await release.promise;
      return { paymentId: "slow-payment" };
    }
  };
  const { service, clock } = fixture({ gateway });
  const confirmation = service.confirm("reservation-1", "admitted-request");
  await entered.promise;
  clock.set(1001);
  release.resolve();

  const result = await confirmation;
  assert.equal(result.status, "confirmed");
  assert.equal(result.paymentId, "slow-payment");
});


test("the HTTP confirmation route remains compatible", async () => {
  const calls = [];
  const reservation = { id: "http-one", amount: 99, expiresAt: 1000, status: "held" };
  const server = createHttpServer({
    reservationStore: { get(id) { assert.equal(id, "http-one"); return reservation; } },
    confirmationService: {
      async confirm(id, key) {
        calls.push({ id, key });
        return { ...reservation, status: "confirmed", idempotencyKey: key, paymentId: "http-pay" };
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const root = await fetch(`${base}/`);
    assert.equal(root.status, 200);
    assert.equal(await root.text(), "reservation-service\n");

    const shown = await fetch(`${base}/reservations/http-one`);
    assert.equal(shown.status, 200);
    assert.deepEqual(await shown.json(), reservation);

    const confirmed = await fetch(`${base}/reservations/http-one/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "http-key" },
      body: "{}"
    });
    assert.equal(confirmed.status, 200);
    assert.equal((await confirmed.json()).paymentId, "http-pay");
    assert.deepEqual(calls, [{ id: "http-one", key: "http-key" }]);

    const missing = await fetch(`${base}/missing`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
/* END PRE-EXISTING VISIBLE TESTS */
