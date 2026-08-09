#!/bin/sh
set -eu
app_dir=${HARBOR_APP_DIR:-/app}
cat > "$app_dir/src/confirmation-service.mjs" <<'EOF_SERVICE'
import { ReservationError } from "./errors.mjs";

export class ConfirmationService {
  constructor({ reservationStore, paymentGateway, clock }) {
    this.reservationStore = reservationStore;
    this.paymentGateway = paymentGateway;
    this.clock = clock;
    this.inFlight = new Map();
  }

  async confirm(reservationId, idempotencyKey) {
    if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
      throw new ReservationError("invalid_idempotency_key", "An idempotency key is required", 400);
    }
    const reservation = this.reservationStore.get(reservationId);
    if (reservation.status === "confirmed") {
      if (reservation.idempotencyKey !== idempotencyKey) {
        throw new ReservationError("already_confirmed", "Reservation was confirmed by another request");
      }
      return reservation;
    }

    const active = this.inFlight.get(reservationId);
    if (active) {
      if (active.idempotencyKey !== idempotencyKey) {
        throw new ReservationError("already_confirmed", "Reservation is being confirmed by another request");
      }
      return active.promise;
    }
    if (this.clock.now() >= reservation.expiresAt) {
      throw new ReservationError("expired", "Reservation has expired", 410);
    }

    const promise = this.#complete(reservation, idempotencyKey);
    this.inFlight.set(reservationId, { idempotencyKey, promise });
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(reservationId)?.promise === promise) {
        this.inFlight.delete(reservationId);
      }
    }
  }

  async #complete(reservation, idempotencyKey) {
    const payment = await this.paymentGateway.charge({
      reservationId: reservation.id,
      amount: reservation.amount
    });
    return this.reservationStore.markConfirmed(reservation.id, {
      idempotencyKey,
      paymentId: payment.paymentId,
      confirmedAt: this.clock.now()
    });
  }
}
EOF_SERVICE
cat > "$app_dir/src/confirmation-concurrency.test.mjs" <<'EOF_TEST'
import assert from "node:assert/strict";
import { test } from "node:test";

import { ManualClock } from "./clock.mjs";
import { ConfirmationService } from "./confirmation-service.mjs";
import { MemoryReservationStore } from "./reservation-store.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

test("overlapping retries share the payment operation", async () => {
  const entered = deferred();
  const release = deferred();
  const calls = [];
  const paymentGateway = {
    async charge(input) {
      calls.push(input);
      entered.resolve();
      await release.promise;
      return { paymentId: `payment-${calls.length}` };
    }
  };
  const reservationStore = new MemoryReservationStore([{
    id: "overlap", amount: 7300, expiresAt: 2000
  }]);
  const service = new ConfirmationService({
    reservationStore,
    paymentGateway,
    clock: new ManualClock(1000)
  });

  const first = service.confirm("overlap", "same-request");
  await entered.promise;
  const second = service.confirm("overlap", "same-request");

  assert.equal(calls.length, 1, "the retry must not start a second charge");
  release.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(secondResult, firstResult);
  assert.equal(reservationStore.get("overlap").paymentId, firstResult.paymentId);
});
EOF_TEST
