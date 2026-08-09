import assert from "node:assert/strict";
import { test } from "node:test";

import { ManualClock } from "./clock.mjs";
import { ConfirmationService } from "./confirmation-service.mjs";
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

function fixture(paymentGateway) {
  const reservationStore = new MemoryReservationStore([{
    id: "reservation-1",
    amount: 4200,
    expiresAt: 1000
  }]);
  const service = new ConfirmationService({
    reservationStore,
    paymentGateway,
    clock: new ManualClock(900)
  });
  return { paymentGateway, service };
}

test("concurrent confirmations with one key charge once and share the result", async () => {
  const chargeStarted = deferred();
  const releaseCharge = deferred();
  const paymentGateway = {
    calls: [],
    async charge(input) {
      this.calls.push(input);
      chargeStarted.resolve();
      await releaseCharge.promise;
      return { paymentId: "pay-1" };
    }
  };
  const { service } = fixture(paymentGateway);

  const first = service.confirm("reservation-1", "request-17");
  await chargeStarted.promise;
  const second = service.confirm("reservation-1", "request-17");

  assert.equal(paymentGateway.calls.length, 1);
  releaseCharge.resolve();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.strictEqual(secondResult, firstResult);
  assert.deepEqual(secondResult, firstResult);
  assert.equal(firstResult.paymentId, "pay-1");
  assert.equal(paymentGateway.calls.length, 1);
});

test("a different key is rejected while confirmation is in flight", async () => {
  const chargeStarted = deferred();
  const releaseCharge = deferred();
  const paymentGateway = {
    calls: [],
    async charge(input) {
      this.calls.push(input);
      chargeStarted.resolve();
      await releaseCharge.promise;
      return { paymentId: "pay-1" };
    }
  };
  const { service } = fixture(paymentGateway);

  const first = service.confirm("reservation-1", "request-17");
  await chargeStarted.promise;
  await assert.rejects(
    service.confirm("reservation-1", "different-request"),
    (error) => error.code === "already_confirmed"
  );
  assert.equal(paymentGateway.calls.length, 1);

  releaseCharge.resolve();
  await first;
});

test("a failed shared confirmation can be retried", async () => {
  const chargeStarted = deferred();
  const releaseFailure = deferred();
  const paymentGateway = {
    calls: [],
    async charge(input) {
      this.calls.push(input);
      if (this.calls.length === 1) {
        chargeStarted.resolve();
        await releaseFailure.promise;
        throw new Error("payment declined");
      }
      return { paymentId: "pay-2" };
    }
  };
  const { service } = fixture(paymentGateway);

  const first = service.confirm("reservation-1", "request-17");
  await chargeStarted.promise;
  const second = service.confirm("reservation-1", "request-17");
  releaseFailure.resolve();

  await assert.rejects(first, /payment declined/);
  await assert.rejects(second, /payment declined/);
  const retry = await service.confirm("reservation-1", "request-17");

  assert.equal(retry.paymentId, "pay-2");
  assert.equal(paymentGateway.calls.length, 2);
});
