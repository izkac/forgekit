class ReservationError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

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
