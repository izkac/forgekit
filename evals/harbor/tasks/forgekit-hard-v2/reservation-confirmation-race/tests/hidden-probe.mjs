import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const root = process.env.HARBOR_APP_DIR || "/app";
const [{ ManualClock }, { ConfirmationService }, { MemoryReservationStore }] = await Promise.all([
  import(pathToFileURL(`${root}/src/clock.mjs`)),
  import(pathToFileURL(`${root}/src/confirmation-service.mjs`)),
  import(pathToFileURL(`${root}/src/reservation-store.mjs`))
]);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function makeService(paymentGateway, { now = 100, expiresAt = 200 } = {}) {
  const clock = new ManualClock(now);
  const reservationStore = new MemoryReservationStore([{
    id: "hidden-reservation", amount: 9187, expiresAt
  }]);
  return {
    clock,
    reservationStore,
    service: new ConfirmationService({ reservationStore, paymentGateway, clock })
  };
}

async function sameKeyOverlap() {
  const entered = deferred();
  const release = deferred();
  const calls = [];
  const { service, reservationStore } = makeService({
    async charge(input) {
      calls.push(input);
      entered.resolve();
      await release.promise;
      return { paymentId: `hidden-payment-${calls.length}` };
    }
  });
  const first = service.confirm("hidden-reservation", "hidden-key");
  await entered.promise;
  const replay = service.confirm("hidden-reservation", "hidden-key");
  assert.equal(calls.length, 1);
  release.resolve();
  const results = await Promise.all([first, replay]);
  assert.deepEqual(results[1], results[0]);
  assert.equal(calls.length, 1);
  assert.equal(reservationStore.get("hidden-reservation").paymentId, results[0].paymentId);
}

async function differentKeyOverlap() {
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  const { service } = makeService({
    async charge() {
      calls += 1;
      if (calls > 1) throw new Error("a conflicting request reached the gateway");
      entered.resolve();
      await release.promise;
      return { paymentId: "winner" };
    }
  });
  const winner = service.confirm("hidden-reservation", "winner-key");
  await entered.promise;
  await assert.rejects(
    service.confirm("hidden-reservation", "loser-key"),
    (error) => error.code === "already_confirmed"
  );
  assert.equal(calls, 1);
  release.resolve();
  await winner;
}

async function failureCanRetry() {
  const entered = deferred();
  const failure = deferred();
  let calls = 0;
  const gatewayError = new Error("declined");
  const { service } = makeService({
    async charge() {
      calls += 1;
      if (calls === 1) {
        entered.resolve();
        await failure.promise;
      }
      return { paymentId: "retry-payment" };
    }
  });
  const first = service.confirm("hidden-reservation", "retry-key");
  await entered.promise;
  const replay = service.confirm("hidden-reservation", "retry-key");
  assert.equal(calls, 1);
  failure.reject(gatewayError);
  const failed = await Promise.allSettled([first, replay]);
  assert.deepEqual(failed.map((entry) => entry.status), ["rejected", "rejected"]);
  assert.equal(failed[0].reason, gatewayError);
  assert.equal(failed[1].reason, gatewayError);

  const retried = await service.confirm("hidden-reservation", "retry-key");
  assert.equal(retried.paymentId, "retry-payment");
  assert.equal(calls, 2);
}

async function expiryContract() {
  let expiredCalls = 0;
  const expired = makeService({
    async charge() { expiredCalls += 1; return { paymentId: "impossible" }; }
  }, { now: 200, expiresAt: 200 });
  await assert.rejects(
    expired.service.confirm("hidden-reservation", "expired-key"),
    (error) => error.code === "expired"
  );
  assert.equal(expiredCalls, 0);

  const entered = deferred();
  const release = deferred();
  const admitted = makeService({
    async charge() {
      entered.resolve();
      await release.promise;
      return { paymentId: "admitted-payment" };
    }
  }, { now: 199, expiresAt: 200 });
  const confirmation = admitted.service.confirm("hidden-reservation", "admitted-key");
  await entered.promise;
  admitted.clock.set(500);
  release.resolve();
  assert.equal((await confirmation).paymentId, "admitted-payment");
}

let result = { functional: false };
try {
  await sameKeyOverlap();
  await differentKeyOverlap();
  await failureCanRetry();
  await expiryContract();
  result.functional = true;
} catch (error) {
  result.error = error?.code || error?.name || "probe_failure";
}
console.log(`HARBOR_RESERVATION_PROBE ${JSON.stringify(result)}`);
