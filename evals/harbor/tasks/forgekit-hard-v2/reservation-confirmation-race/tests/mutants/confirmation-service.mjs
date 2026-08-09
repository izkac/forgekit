import { ReservationError } from "./errors.mjs";

export class ConfirmationService {
  constructor({ reservationStore, paymentGateway, clock }) {
    this.reservationStore = reservationStore;
    this.paymentGateway = paymentGateway;
    this.clock = clock;
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
    if (this.clock.now() >= reservation.expiresAt) {
      throw new ReservationError("expired", "Reservation has expired", 410);
    }

    // BUG: two callers can both pass the checks and charge before either stores
    // the confirmation. A repeated in-flight idempotency key must share one operation.
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
